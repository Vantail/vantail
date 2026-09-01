//! `database.*` - SQLite, from the runtime.
//!
//! A webview can run SQLite compiled to WebAssembly, and applications do. The
//! cost is not the WASM: it is that the database has nowhere real to live.
//! Persisting it means writing the whole file out on every commit, which is
//! fine for a few megabytes and is not a database; keeping it in the origin's
//! private storage instead means the user cannot find, copy or back up their
//! own data.
//!
//! So this is the same thing every other capability here is: the part a
//! browser cannot do. The file is an ordinary `.sqlite` on disk, in a
//! directory the config already granted, and it is written by SQLite itself -
//! journalling, incremental writes, a real backup API and all.
//!
//! Three things in here are deliberate, and each of them is a bug somebody
//! already had:
//!
//! - **An integer that does not fit in a JavaScript number is an error, not a
//!   rounded answer.** SQLite's INTEGER is 64-bit and JSON's number is a
//!   double, so anything past 2^53 silently loses its low bits. For a ledger
//!   in minor units that is money. Ask for `bigint` and get every integer
//!   exactly; do not ask, and an unrepresentable one is refused rather than
//!   quietly changed.
//! - **One connection is one thread, and a transaction holds it.** SQLite has
//!   one write transaction per connection. Callers that overlap wait their
//!   turn rather than joining somebody else's `BEGIN`, because sharing one
//!   means a rollback in either discards the other's writes.
//! - **A transaction that is never finished is rolled back.** The statements
//!   inside one come from JavaScript, an IPC round trip at a time, so a page
//!   that throws between `BEGIN` and `COMMIT` would otherwise wedge the
//!   connection for the life of the process.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine;
use rusqlite::types::{ToSqlOutput, Value as SqlValue, ValueRef};
use rusqlite::Connection;
use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::error::{ApiError, ApiResult};
use crate::ipc::{Outgoing, Request, Response};
use crate::permissions::Access;
use crate::state::{MainCtx, Runtime};

const BASE64: base64::engine::general_purpose::GeneralPurpose =
    base64::engine::general_purpose::STANDARD;

/// The largest integer a JavaScript number holds exactly.
const MAX_SAFE: i64 = 9_007_199_254_740_991;

/// How long a transaction may sit between statements before it is rolled back.
///
/// The statements arrive one IPC round trip at a time, so an application that
/// throws after `BEGIN` and never catches it would otherwise hold the
/// connection until the process ended.
const TRANSACTION_IDLE: Duration = Duration::from_secs(30);

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenParams {
    /// Where the file lives. Checked against `permissions.filesystem` write
    /// scope, the same as any other write.
    path: String,
    /// Fail rather than create the file. Default `false`.
    #[serde(default)]
    read_only: bool,
    /// Encrypt the file, with a key the runtime reads from the OS credential
    /// store under this name.
    ///
    /// The key never crosses into JavaScript, which is the point: a page that
    /// has been taken over can ask for the database it was already allowed to
    /// open, and still cannot read the key out to take the file elsewhere.
    #[serde(default)]
    key_secret: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct KeyParams {
    /// The credential store entry to create the key in.
    secret: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StatementParams {
    id: u32,
    sql: String,
    #[serde(default)]
    params: Vec<Value>,
    /// Return every integer as a `bigint` rather than a number.
    #[serde(default)]
    bigint: bool,
    /// Run inside this transaction. Without it, a statement waits for any
    /// open transaction to finish.
    #[serde(default)]
    transaction: Option<u32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HandleParams {
    id: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TransactionParams {
    id: u32,
    transaction: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotParams {
    id: u32,
    /// Where to write the copy. Also checked as a write.
    path: String,
}

// ---------------------------------------------------------------------------
// The connection registry
// ---------------------------------------------------------------------------

/// Where a job's answer goes.
///
/// The connection's thread replies for itself rather than handing the result
/// back to a waiting worker: a query is as slow as it is, and nothing - not
/// the event loop, not the shared pool - should be held up by one.
struct Reply {
    id: String,
    window: String,
}

impl Reply {
    fn send(self, rt: &Runtime, result: ApiResult) {
        rt.send(
            Some(self.window),
            Outgoing::Response(Response::from_result(self.id, result)),
        );
    }
}

/// What a caller asked the connection's own thread to do.
enum Job {
    Query {
        sql: String,
        params: Vec<Value>,
        bigint: bool,
        transaction: Option<u32>,
        reply: Reply,
    },
    Execute {
        sql: String,
        params: Vec<Value>,
        bigint: bool,
        transaction: Option<u32>,
        reply: Reply,
    },
    Begin {
        transaction: u32,
        reply: Reply,
    },
    Commit {
        transaction: u32,
        reply: Reply,
    },
    Rollback {
        transaction: u32,
        reply: Reply,
    },
    Checkpoint {
        reply: Reply,
    },
    Snapshot {
        path: PathBuf,
        reply: Reply,
    },
    Close {
        reply: Reply,
    },
}

impl Job {
    /// The transaction this job belongs to, if any.
    ///
    /// Everything else has to wait while one is open - which is the whole
    /// point, and is what stops two callers sharing a `BEGIN`.
    fn transaction(&self) -> Option<u32> {
        match self {
            Job::Query { transaction, .. } | Job::Execute { transaction, .. } => *transaction,
            Job::Begin { .. } => None,
            Job::Commit { transaction, .. } | Job::Rollback { transaction, .. } => {
                Some(*transaction)
            }
            // Closing, checkpointing and copying are connection-wide, so they
            // queue behind a transaction like anything else.
            Job::Checkpoint { .. } | Job::Snapshot { .. } | Job::Close { .. } => None,
        }
    }

    fn into_reply(self) -> Reply {
        match self {
            Job::Query { reply, .. }
            | Job::Execute { reply, .. }
            | Job::Begin { reply, .. }
            | Job::Commit { reply, .. }
            | Job::Rollback { reply, .. }
            | Job::Checkpoint { reply, .. }
            | Job::Snapshot { reply, .. }
            | Job::Close { reply, .. } => reply,
        }
    }
}

/// Open connections, by the id the application knows them by.
#[derive(Default)]
pub struct Databases {
    next: AtomicU32,
    next_transaction: AtomicU32,
    open: Mutex<HashMap<u32, Sender<Job>>>,
}

impl Databases {
    fn insert(&self, jobs: Sender<Job>) -> u32 {
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        self.open
            .lock()
            .expect("databases poisoned")
            .insert(id, jobs);
        id
    }

    fn remove(&self, id: u32) {
        self.open.lock().expect("databases poisoned").remove(&id);
    }

    fn sender(&self, id: u32) -> Result<Sender<Job>, ApiError> {
        self.open
            .lock()
            .expect("databases poisoned")
            .get(&id)
            .cloned()
            .ok_or_else(|| {
                ApiError::new(
                    crate::error::code::NOT_FOUND,
                    format!("There is no open database with id {id}"),
                )
            })
    }

    /// Hand a job to the connection's thread. The thread answers the window.
    fn hand(&self, id: u32, job: Job) -> Result<(), ApiError> {
        self.sender(id)?.send(job).map_err(|_| gone(id))
    }

    /// Close every connection, on the way out.
    ///
    /// Dropping the sender is what tells each thread to stop, and its loop
    /// rolls back anything unfinished before it does.
    pub fn shutdown(&self) {
        self.open.lock().expect("databases poisoned").clear();
    }
}

fn gone(id: u32) -> ApiError {
    ApiError::new(
        crate::error::code::NOT_FOUND,
        format!("Database {id} has closed"),
    )
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/// Every call but `open` is handed to the connection's own thread, which
/// answers for itself - so a slow query holds up neither the event loop nor
/// the shared worker pool.
pub fn dispatch(ctx: &mut MainCtx<'_>, id: &str, method: &str, params: Value) -> Option<ApiResult> {
    let rt = ctx.rt;
    if let Err(error) = rt.permissions.require(rt.permissions.database, method) {
        return Some(Err(error));
    }

    let reply = Reply {
        id: id.to_string(),
        window: ctx.source.to_string(),
    };

    let queued = match method {
        "database.open" => return Some(open(rt, method, params)),

        // Making the key is its own call so the key never has to exist in
        // JavaScript, even for the moment it takes to store it.
        "database.createKey" => {
            if let Err(error) = rt.permissions.require(rt.permissions.secrets, method) {
                return Some(Err(error));
            }
            let params: Result<KeyParams, _> = Request::params(method, params);
            return Some(params.and_then(|p| create_key(rt, &p.secret)));
        }

        "database.query" => Request::params::<StatementParams>(method, params).and_then(|p| {
            rt.databases.hand(
                p.id,
                Job::Query {
                    sql: p.sql,
                    params: p.params,
                    bigint: p.bigint,
                    transaction: p.transaction,
                    reply,
                },
            )
        }),

        "database.execute" => Request::params::<StatementParams>(method, params).and_then(|p| {
            rt.databases.hand(
                p.id,
                Job::Execute {
                    sql: p.sql,
                    params: p.params,
                    bigint: p.bigint,
                    transaction: p.transaction,
                    reply,
                },
            )
        }),

        "database.begin" => Request::params::<HandleParams>(method, params).and_then(|p| {
            let transaction = rt
                .databases
                .next_transaction
                .fetch_add(1, Ordering::Relaxed)
                + 1;
            rt.databases.hand(p.id, Job::Begin { transaction, reply })
        }),

        "database.commit" => Request::params::<TransactionParams>(method, params).and_then(|p| {
            rt.databases.hand(
                p.id,
                Job::Commit {
                    transaction: p.transaction,
                    reply,
                },
            )
        }),

        "database.rollback" => Request::params::<TransactionParams>(method, params).and_then(|p| {
            rt.databases.hand(
                p.id,
                Job::Rollback {
                    transaction: p.transaction,
                    reply,
                },
            )
        }),

        "database.checkpoint" => Request::params::<HandleParams>(method, params)
            .and_then(|p| rt.databases.hand(p.id, Job::Checkpoint { reply })),

        "database.snapshot" => Request::params::<SnapshotParams>(method, params).and_then(|p| {
            // The copy is a new file, so it needs the same permission the
            // database itself did.
            let path = rt.permissions.check_path(&p.path, Access::Write)?;
            rt.databases.hand(p.id, Job::Snapshot { path, reply })
        }),

        "database.close" => Request::params::<HandleParams>(method, params)
            .and_then(|p| rt.databases.hand(p.id, Job::Close { reply })),

        _ => return Some(Err(ApiError::unknown_method(method))),
    };

    match queued {
        // The thread has it, and will answer the window itself.
        Ok(()) => None,
        Err(error) => Some(Err(error)),
    }
}

fn open(rt: &Arc<Runtime>, method: &str, params: Value) -> ApiResult {
    let OpenParams {
        path,
        read_only,
        key_secret,
    } = Request::params(method, params)?;

    // Reading the key is reading a secret, so it needs that permission too:
    // `database` says this application may keep a database, not that it may
    // help itself to the credential store.
    let key = match &key_secret {
        Some(name) => {
            rt.permissions.require(rt.permissions.secrets, method)?;
            Some(read_key(rt, name)?)
        }
        None => None,
    };

    // A database is a file, so it goes through the same scope a file write
    // does - `$APPDATA/**` and the rest all work exactly as they read.
    let access = if read_only {
        Access::Read
    } else {
        Access::Write
    };
    let resolved = rt.permissions.check_path(&path, access)?;

    let (jobs, inbox) = channel();
    let (ready, opened) = channel();
    let label = resolved.display().to_string();
    let runtime = Arc::clone(rt);

    // Registered before the thread starts, so the thread can take itself back
    // out when it finishes rather than leaving a dead entry behind.
    let id = rt.databases.insert(jobs);

    let spawned = std::thread::Builder::new()
        .name(format!("vantail-db-{id}"))
        .spawn(move || serve(runtime, id, resolved, read_only, key, ready, inbox));

    if let Err(error) = spawned {
        rt.databases.remove(id);
        return Err(ApiError::internal(format!(
            "Could not start a database thread: {error}"
        )));
    }

    // The thread reports whether the file actually opened, so a bad path is
    // an error from `open` rather than from the first query. Opening is quick
    // even when it creates the file; everything slow happens later, on that
    // thread.
    let result = opened.recv().unwrap_or_else(|_| {
        Err(ApiError::internal(
            "The database thread stopped before it opened anything",
        ))
    });
    if let Err(error) = result {
        rt.databases.remove(id);
        return Err(error);
    }

    Ok(json!({ "id": id, "path": label }))
}

// ---------------------------------------------------------------------------
// The connection's own thread
// ---------------------------------------------------------------------------

fn serve(
    rt: Arc<Runtime>,
    id: u32,
    path: PathBuf,
    read_only: bool,
    key: Option<String>,
    ready: Sender<ApiResult>,
    inbox: Receiver<Job>,
) {
    let connection = match connect(&path, read_only, key.as_deref()) {
        Ok(connection) => {
            let _ = ready.send(Ok(Value::Null));
            connection
        }
        Err(error) => {
            // `open` takes the registration back out on this path.
            let _ = ready.send(Err(error));
            return;
        }
    };

    pump(&rt, connection, inbox);
    // However the loop ended - closed, or every sender dropped at shutdown -
    // this connection is gone and its id must not answer again.
    rt.databases.remove(id);
}

fn connect(path: &PathBuf, read_only: bool, key: Option<&str>) -> Result<Connection, ApiError> {
    use rusqlite::OpenFlags;

    let flags = if read_only {
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX
    } else {
        OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_CREATE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
    };

    let connection = Connection::open_with_flags(path, flags)
        .map_err(|e| failed(&format!("Could not open `{}`", path.display()), &e))?;

    // Before anything else touches the file. SQLCipher will refuse a key
    // given after the connection has already read something.
    if let Some(key) = key {
        apply_key(&connection, key, path)?;
    }

    if !read_only {
        // Write-ahead logging, because the alternative is a rollback journal
        // that blocks readers on every write. `NORMAL` is the durability WAL
        // is designed around: a crash cannot corrupt the database, though the
        // last commits may not have reached the disk.
        connection
            .pragma_update(None, "journal_mode", "WAL")
            .map_err(|e| failed("Could not enable WAL", &e))?;
        connection
            .pragma_update(None, "synchronous", "NORMAL")
            .map_err(|e| failed("Could not set synchronous", &e))?;
    }

    // Off by default in SQLite itself, for compatibility with 2005. An
    // application that declared a foreign key meant it.
    connection
        .pragma_update(None, "foreign_keys", true)
        .map_err(|e| failed("Could not enable foreign keys", &e))?;
    // A writer waits for a reader rather than failing instantly.
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(|e| failed("Could not set the busy timeout", &e))?;

    Ok(connection)
}

fn pump(rt: &Runtime, connection: Connection, inbox: Receiver<Job>) {
    /// A transaction that is open, and when it was last touched.
    struct Open {
        id: u32,
        touched: Instant,
    }

    let mut transaction: Option<Open> = None;
    // Jobs that arrived for somebody else while a transaction was open. They
    // are answered in arrival order once it finishes.
    let mut waiting: Vec<Job> = Vec::new();

    loop {
        // Anything that was queued behind a transaction can run now.
        if transaction.is_none() && !waiting.is_empty() {
            let ready = std::mem::take(&mut waiting);
            let mut requeued = Vec::new();
            for job in ready {
                if let Some(job) = handle(rt, &connection, job, &mut transaction) {
                    requeued.push(job);
                }
            }
            waiting = requeued;
            continue;
        }

        let next = match &transaction {
            // While a transaction is open the loop must wake up on its own to
            // notice one that has been abandoned.
            Some(open) => {
                let idle = TRANSACTION_IDLE.saturating_sub(open.touched.elapsed());
                match inbox.recv_timeout(idle) {
                    Ok(job) => Some(job),
                    Err(RecvTimeoutError::Timeout) => {
                        let _ = connection.execute_batch("ROLLBACK");
                        transaction = None;
                        continue;
                    }
                    Err(RecvTimeoutError::Disconnected) => None,
                }
            }
            None => inbox.recv().ok(),
        };

        let Some(job) = next else {
            // Every sender is gone: the connection was closed or the runtime
            // is shutting down. An unfinished transaction is not a commit.
            if transaction.is_some() {
                let _ = connection.execute_batch("ROLLBACK");
            }
            return;
        };

        if let Job::Close { reply } = job {
            if transaction.is_some() {
                let _ = connection.execute_batch("ROLLBACK");
            }
            // Answer everything still queued, so no caller waits forever.
            for job in waiting.drain(..) {
                job.into_reply().send(
                    rt,
                    Err(ApiError::new(
                        crate::error::code::NOT_FOUND,
                        "The database was closed while this was waiting",
                    )),
                );
            }
            reply.send(rt, close(connection));
            return;
        }

        if let Some(job) = handle(rt, &connection, job, &mut transaction) {
            waiting.push(job);
        }
    }

    /// Run a job, or hand it back to be queued behind the open transaction.
    fn handle(
        rt: &Runtime,
        connection: &Connection,
        job: Job,
        transaction: &mut Option<Open>,
    ) -> Option<Job> {
        if let Some(open) = transaction {
            match job.transaction() {
                // Somebody else's work, or work that has no transaction: it
                // waits rather than joining this one.
                Some(id) if id == open.id => open.touched = Instant::now(),
                _ => return Some(job),
            }
        } else if let Some(id) = job.transaction() {
            // The transaction it names has already finished, or timed out.
            job.into_reply().send(rt, Err(ApiError::new(
                crate::error::code::NOT_FOUND,
                format!("Transaction {id} is not open - it was committed, rolled back, or timed out after {}s of inactivity", TRANSACTION_IDLE.as_secs()),
            )));
            return None;
        }

        match job {
            Job::Query {
                sql,
                params,
                bigint,
                reply,
                ..
            } => reply.send(rt, query(connection, &sql, &params, bigint)),
            Job::Execute {
                sql,
                params,
                bigint,
                reply,
                ..
            } => reply.send(rt, execute(connection, &sql, &params, bigint)),
            Job::Begin {
                transaction: id,
                reply,
            } => {
                // IMMEDIATE, not DEFERRED: take the write lock now rather than
                // discovering at the first write that somebody else has it.
                match connection.execute_batch("BEGIN IMMEDIATE") {
                    Ok(()) => {
                        *transaction = Some(Open {
                            id,
                            touched: Instant::now(),
                        });
                        reply.send(rt, Ok(json!({ "transaction": id })));
                    }
                    Err(error) => {
                        reply.send(rt, Err(failed("Could not begin a transaction", &error)));
                    }
                }
            }
            Job::Commit { reply, .. } => {
                let result = connection
                    .execute_batch("COMMIT")
                    .map(|()| Value::Null)
                    .map_err(|e| failed("Could not commit", &e));
                // Committed or not, the transaction is over: leaving it open
                // after a failed COMMIT would wedge the connection.
                *transaction = None;
                reply.send(rt, result);
            }
            Job::Rollback { reply, .. } => {
                let result = connection
                    .execute_batch("ROLLBACK")
                    .map(|()| Value::Null)
                    .map_err(|e| failed("Could not roll back", &e));
                *transaction = None;
                reply.send(rt, result);
            }
            Job::Checkpoint { reply } => reply.send(rt, checkpoint(connection)),
            Job::Snapshot { path, reply } => reply.send(rt, snapshot(connection, &path)),
            // Handled by the caller, which has to stop the loop.
            Job::Close { reply } => reply.send(rt, Ok(Value::Null)),
        }
        None
    }
}

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

fn query(connection: &Connection, sql: &str, params: &[Value], bigint: bool) -> ApiResult {
    let mut statement = connection
        .prepare(sql)
        .map_err(|e| failed("Could not prepare the statement", &e))?;

    let columns: Vec<String> = statement
        .column_names()
        .into_iter()
        .map(str::to_string)
        .collect();

    let bound = bind(params)?;
    let mut rows = statement
        .query(rusqlite::params_from_iter(bound))
        .map_err(|e| failed("Could not run the query", &e))?;

    let mut out = Vec::new();
    while let Some(row) = rows
        .next()
        .map_err(|e| failed("Could not read a row", &e))?
    {
        let mut object = Map::with_capacity(columns.len());
        for (index, name) in columns.iter().enumerate() {
            let value = row
                .get_ref(index)
                .map_err(|e| failed("Could not read a column", &e))?;
            object.insert(name.clone(), encode(value, bigint, name)?);
        }
        out.push(Value::Object(object));
    }

    Ok(json!({ "rows": out, "columns": columns }))
}

fn execute(connection: &Connection, sql: &str, params: &[Value], bigint: bool) -> ApiResult {
    let bound = bind(params)?;
    let changed = connection
        .execute(sql, rusqlite::params_from_iter(bound))
        .map_err(|e| failed("Could not run the statement", &e))?;

    // `last_insert_rowid` is an i64 and a table can outgrow a JS number, so
    // it goes out under the same rule as any other integer.
    let rowid = connection.last_insert_rowid();
    Ok(json!({
        "changes": changed,
        "lastInsertRowId": number(rowid, bigint, "lastInsertRowId")?,
    }))
}

fn checkpoint(connection: &Connection) -> ApiResult {
    // TRUNCATE rather than PASSIVE: the point of asking is to get the WAL
    // folded back into the database, usually just before copying it.
    connection
        .pragma_update(None, "wal_checkpoint", "TRUNCATE")
        .map_err(|e| failed("Could not checkpoint", &e))?;
    Ok(Value::Null)
}

fn snapshot(connection: &Connection, path: &PathBuf) -> ApiResult {
    // SQLite's own backup API rather than copying the file: it takes a
    // consistent copy of a database that is being written to, which a
    // filesystem copy cannot promise.
    connection
        .backup(rusqlite::MAIN_DB, path, None)
        .map_err(|e| {
            failed(
                &format!("Could not write a copy to `{}`", path.display()),
                &e,
            )
        })?;
    Ok(json!({ "path": path.display().to_string() }))
}

fn close(connection: Connection) -> ApiResult {
    connection
        .close()
        .map_err(|(_, error)| failed("Could not close the database", &error))?;
    Ok(Value::Null)
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/// How many bytes of key SQLCipher is handed. 256 bits, as a raw key.
const KEY_BYTES: usize = 32;

/// Hand the key to SQLCipher, then prove it was the right one.
///
/// `x'...'` is SQLCipher's raw-key form: the bytes are used as the key
/// directly rather than run through PBKDF2 as a passphrase, which is what you
/// want for a key that was random to begin with.
///
/// The check afterwards matters. Keying a connection never fails on its own -
/// it is the first read that discovers the file will not decrypt - so without
/// this a wrong key would surface later as an unrelated-looking error in the
/// middle of an application's first query.
#[cfg(feature = "database-encryption")]
fn apply_key(connection: &Connection, key: &str, path: &Path) -> Result<(), ApiError> {
    connection
        .pragma_update(None, "key", format!("x'{key}'"))
        .map_err(|e| failed("Could not key the database", &e))?;

    connection
        .prepare("select count(*) from sqlite_schema")
        .and_then(|mut statement| statement.query_row([], |row| row.get::<_, i64>(0)))
        .map(|_| ())
        .map_err(|_| {
            ApiError::new(
                crate::error::code::PERMISSION_DENIED,
                format!(
                    "`{}` did not decrypt with that key. Either the key is wrong, or the file \
                     is a plain unencrypted database.",
                    path.display()
                ),
            )
        })
}

/// The same call in a build without SQLCipher, which cannot honour it.
///
/// Refusing is the only safe answer: carrying on would open the file
/// unencrypted and hand back a working database, and the application would
/// have no way to tell that its ledger was in the clear.
#[cfg(not(feature = "database-encryption"))]
fn apply_key(_connection: &Connection, _key: &str, _path: &Path) -> Result<(), ApiError> {
    Err(ApiError::unsupported(
        "This runtime was built without database encryption. Rebuild with the \
         `database-encryption` feature, or open the database without `keySecret`.",
    ))
}

/// Read a key out of the OS credential store.
fn read_key(rt: &Runtime, secret: &str) -> Result<String, ApiError> {
    let stored = crate::api::secrets::read(rt, secret)?.ok_or_else(|| {
        ApiError::new(
            crate::error::code::NOT_FOUND,
            format!(
                "There is no key stored as `{secret}`. Create one with \
                 `database.createKey` before opening an encrypted database."
            ),
        )
    })?;

    // Stored as hex, so what comes back is the key rather than a passphrase
    // that happened to survive a round trip through the credential store.
    if stored.len() != KEY_BYTES * 2 || !stored.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(ApiError::invalid_params(format!(
            "`{secret}` does not hold a database key. `database.createKey` writes one."
        )));
    }
    Ok(stored)
}

/// Make a key and put it straight into the credential store.
///
/// Generated here rather than in the application so the key has no reason to
/// exist in the webview at all - not in a variable, not in a promise, not in
/// a heap snapshot. The application never sees it, and does not need to.
fn create_key(rt: &Runtime, secret: &str) -> ApiResult {
    if crate::api::secrets::read(rt, secret)?.is_some() {
        return Err(ApiError::new(
            crate::error::code::ALREADY_EXISTS,
            format!(
                "`{secret}` already holds a key. Overwriting it would make every database \
                 it opened unreadable, so it has to be removed on purpose first."
            ),
        ));
    }

    let mut bytes = [0_u8; KEY_BYTES];
    getrandom::fill(&mut bytes)
        .map_err(|e| ApiError::internal(format!("Could not generate a key: {e}")))?;

    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    crate::api::secrets::write(rt, secret, &hex)?;
    Ok(Value::Null)
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

/// Turn the JSON a caller sent into something SQLite can bind.
fn bind(params: &[Value]) -> Result<Vec<SqlValue>, ApiError> {
    params.iter().map(one).collect()
}

fn one(value: &Value) -> Result<SqlValue, ApiError> {
    Ok(match value {
        Value::Null => SqlValue::Null,
        Value::Bool(flag) => SqlValue::Integer(i64::from(*flag)),
        Value::String(text) => SqlValue::Text(text.clone()),
        Value::Number(number) => {
            if let Some(integer) = number.as_i64() {
                SqlValue::Integer(integer)
            } else if let Some(real) = number.as_f64() {
                SqlValue::Real(real)
            } else {
                return Err(ApiError::invalid_params(format!(
                    "`{number}` is not a number SQLite can store"
                )));
            }
        }
        // The two things JSON cannot carry, tagged by the SDK.
        Value::Object(object) => {
            if let Some(Value::String(text)) = object.get("$bigint") {
                let integer: i64 = text.parse().map_err(|_| {
                    ApiError::invalid_params(format!("`{text}` is not a 64-bit integer"))
                })?;
                SqlValue::Integer(integer)
            } else if let Some(Value::String(encoded)) = object.get("$blob") {
                let bytes = BASE64.decode(encoded.as_bytes()).map_err(|e| {
                    ApiError::invalid_params(format!("A blob parameter is not valid base64: {e}"))
                })?;
                SqlValue::Blob(bytes)
            } else {
                return Err(ApiError::invalid_params(
                    "An object parameter must be a tagged bigint or blob. Pass JSON as a string.",
                ));
            }
        }
        Value::Array(_) => {
            return Err(ApiError::invalid_params(
                "An array parameter is not a SQLite value. Pass JSON as a string, or one parameter per value.",
            ))
        }
    })
}

/// Turn a column back into JSON.
fn encode(value: ValueRef<'_>, bigint: bool, column: &str) -> Result<Value, ApiError> {
    Ok(match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(integer) => number(integer, bigint, column)?,
        ValueRef::Real(real) => json!(real),
        ValueRef::Text(bytes) => match std::str::from_utf8(bytes) {
            Ok(text) => json!(text),
            // A TEXT column holding bytes that are not UTF-8 is a real thing
            // in an old database, and guessing at it would be worse.
            Err(_) => json!({ "$blob": BASE64.encode(bytes) }),
        },
        ValueRef::Blob(bytes) => json!({ "$blob": BASE64.encode(bytes) }),
    })
}

/// A 64-bit integer, as a number when that is exact and never when it is not.
///
/// This is the whole reason the capability spells `bigint` out. JSON has one
/// numeric type and it is a double, so an id or a balance in minor units past
/// 2^53 comes back changed. Refusing is the only answer that cannot be wrong
/// quietly.
fn number(integer: i64, bigint: bool, column: &str) -> Result<Value, ApiError> {
    if bigint {
        return Ok(json!({ "$bigint": integer.to_string() }));
    }
    if integer.abs() > MAX_SAFE {
        return Err(ApiError::new(
            crate::error::code::INVALID_PARAMS,
            format!(
                "`{column}` is {integer}, which a JavaScript number cannot hold exactly. \
                 Pass `bigint: true` to read it as a BigInt."
            ),
        ));
    }
    Ok(json!(integer))
}

fn failed(context: &str, error: &rusqlite::Error) -> ApiError {
    ApiError::new(crate::error::code::IO_ERROR, format!("{context}: {error}"))
}

/// So `ToSqlOutput` is used, keeping the import honest across rusqlite versions.
#[allow(dead_code)]
fn _assert_bindable(value: SqlValue) -> ToSqlOutput<'static> {
    ToSqlOutput::Owned(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory() -> Connection {
        let connection = Connection::open_in_memory().expect("in-memory database");
        connection
            .pragma_update(None, "foreign_keys", true)
            .expect("foreign keys");
        connection
    }

    #[test]
    fn an_integer_past_two_to_the_53_is_refused_rather_than_rounded() {
        // The bug this exists to prevent: a ledger in minor units silently
        // losing its low bits somewhere past nine quadrillion.
        let error = number(9_007_199_254_740_993, false, "amount").unwrap_err();
        assert!(error.message.contains("bigint: true"), "{}", error.message);

        // And with `bigint` it comes back exactly, as a string the SDK turns
        // into a BigInt.
        let value = number(9_007_199_254_740_993, true, "amount").unwrap();
        assert_eq!(value["$bigint"], "9007199254740993");
    }

    #[test]
    fn an_integer_that_does_fit_is_an_ordinary_number() {
        assert_eq!(number(42, false, "n").unwrap(), json!(42));
        assert_eq!(number(MAX_SAFE, false, "n").unwrap(), json!(MAX_SAFE));
        assert_eq!(number(-MAX_SAFE, false, "n").unwrap(), json!(-MAX_SAFE));
    }

    #[test]
    fn a_round_trip_keeps_every_bit_of_a_large_integer() {
        let connection = memory();
        connection
            .execute_batch("create table t(v integer)")
            .unwrap();
        execute(
            &connection,
            "insert into t values (?)",
            &[json!({ "$bigint": "9223372036854775807" })],
            false,
        )
        .unwrap();

        let out = query(&connection, "select v from t", &[], true).unwrap();
        assert_eq!(out["rows"][0]["v"]["$bigint"], "9223372036854775807");

        // Read without asking for bigint and it refuses rather than lying.
        assert!(query(&connection, "select v from t", &[], false).is_err());
    }

    #[test]
    fn blobs_survive_in_both_directions() {
        let connection = memory();
        connection.execute_batch("create table t(b blob)").unwrap();
        execute(
            &connection,
            "insert into t values (?)",
            &[json!({ "$blob": "AAECAw==" })],
            false,
        )
        .unwrap();

        let out = query(&connection, "select b from t", &[], false).unwrap();
        assert_eq!(out["rows"][0]["b"]["$blob"], "AAECAw==");
    }

    #[test]
    fn text_that_is_not_utf8_comes_back_as_bytes_rather_than_mangled() {
        let connection = memory();
        connection.execute_batch("create table t(v text)").unwrap();
        // A TEXT column holding invalid UTF-8 is a real thing in an old
        // database, and replacement characters would be silent damage.
        connection
            .execute("insert into t values (cast(x'ff' as text))", [])
            .unwrap();

        let out = query(&connection, "select v from t", &[], false).unwrap();
        assert!(out["rows"][0]["v"]["$blob"].is_string());
    }

    #[test]
    fn the_ordinary_types_map_the_way_you_would_expect() {
        let connection = memory();
        let out = query(
            &connection,
            "select 1 as i, 2.5 as r, 'x' as t, null as n",
            &[],
            false,
        )
        .unwrap();

        let row = &out["rows"][0];
        assert_eq!(row["i"], json!(1));
        assert_eq!(row["r"], json!(2.5));
        assert_eq!(row["t"], json!("x"));
        assert_eq!(row["n"], Value::Null);
        assert_eq!(out["columns"], json!(["i", "r", "t", "n"]));
    }

    #[test]
    fn parameters_are_bound_rather_than_pasted_in() {
        let connection = memory();
        connection.execute_batch("create table t(v text)").unwrap();
        execute(
            &connection,
            "insert into t values (?)",
            &[json!("x')--")],
            false,
        )
        .unwrap();

        // The value came back whole, which it would not have if it had been
        // spliced into the SQL.
        let out = query(&connection, "select v from t", &[], false).unwrap();
        assert_eq!(out["rows"][0]["v"], json!("x')--"));
    }

    #[test]
    fn an_array_parameter_says_what_to_do_instead() {
        let error = one(&json!([1, 2, 3])).unwrap_err();
        assert!(error.message.contains("one parameter per value"));
    }

    #[test]
    fn an_unknown_tagged_object_is_refused() {
        let error = one(&json!({ "nope": 1 })).unwrap_err();
        assert_eq!(error.code, crate::error::code::INVALID_PARAMS);
    }

    #[test]
    fn execute_reports_what_it_changed() {
        let connection = memory();
        connection
            .execute_batch("create table t(v integer)")
            .unwrap();

        let out = execute(&connection, "insert into t values (?)", &[json!(7)], false).unwrap();
        assert_eq!(out["changes"], json!(1));
        assert_eq!(out["lastInsertRowId"], json!(1));
    }

    #[test]
    fn a_foreign_key_is_enforced_because_the_pragma_is_on() {
        // SQLite has it off by default for compatibility with 2005. An
        // application that wrote `references` meant it.
        let connection = memory();
        connection
            .execute_batch(
                "create table parent(id integer primary key);
                 create table child(parent integer references parent(id));",
            )
            .unwrap();

        let error = execute(&connection, "insert into child values (9)", &[], false).unwrap_err();
        assert!(error.message.contains("FOREIGN KEY"), "{}", error.message);
    }

    /// A scratch directory this test owns, cleaned up on the way out.
    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "vantail-db-{name}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::create_dir_all(&dir).expect("scratch directory");
        dir
    }

    #[cfg(feature = "database-encryption")]
    #[test]
    fn an_encrypted_database_is_unreadable_without_its_key() {
        let dir = scratch("encrypted");
        let path = dir.join("ledger.sqlite");
        let key = "0".repeat(64);

        {
            let connection = connect(&path, false, Some(&key)).expect("opens");
            connection
                .execute_batch(
                    "create table entry(note text); insert into entry values ('secret');",
                )
                .unwrap();
        }

        // The bytes on disk are not a SQLite file: an unencrypted database
        // starts with "SQLite format 3", and this must not.
        let bytes = std::fs::read(&path).expect("the file exists");
        assert!(
            !bytes.starts_with(b"SQLite format 3"),
            "the file is in the clear"
        );
        assert!(
            !String::from_utf8_lossy(&bytes).contains("secret"),
            "the row is readable in the raw file"
        );

        // The right key reads it back.
        let reopened = connect(&path, false, Some(&key)).expect("reopens");
        let out = query(&reopened, "select note from entry", &[], false).unwrap();
        assert_eq!(out["rows"][0]["note"], json!("secret"));
        drop(reopened);

        // The wrong one is refused, and says so rather than failing later in
        // the middle of somebody's first query.
        let wrong = "1".repeat(64);
        let error = connect(&path, false, Some(&wrong)).expect_err("wrong key");
        assert_eq!(error.code, crate::error::code::PERMISSION_DENIED);
        assert!(
            error.message.contains("did not decrypt"),
            "{}",
            error.message
        );

        // And so is opening it as a plain database.
        assert!(connect(&path, false, None).was_refused());

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Opening an encrypted file without a key either fails outright or opens
    /// a handle that cannot read anything. Either is a refusal; neither hands
    /// back readable rows.
    #[cfg(feature = "database-encryption")]
    trait Unreadable {
        fn was_refused(self) -> bool;
    }

    #[cfg(feature = "database-encryption")]
    impl Unreadable for Result<Connection, ApiError> {
        fn was_refused(self) -> bool {
            match self {
                Err(_) => true,
                Ok(connection) => query(&connection, "select note from entry", &[], false).is_err(),
            }
        }
    }

    #[cfg(not(feature = "database-encryption"))]
    #[test]
    fn a_build_without_encryption_refuses_a_key_rather_than_ignoring_it() {
        // The dangerous outcome is opening the file in the clear and handing
        // back a working database, so this has to be an error.
        let dir = scratch("nokey");
        let path = dir.join("ledger.sqlite");
        let error = connect(&path, false, Some(&"0".repeat(64))).expect_err("no sqlcipher");
        assert_eq!(error.code, crate::error::code::UNSUPPORTED);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_application_can_choose_its_own_durability() {
        // The runtime opens with `synchronous = NORMAL`, which in WAL mode
        // cannot corrupt the database but can lose the last commits to a
        // power cut. A ledger may want to pay for FULL instead, so check that
        // saying so from the application actually takes.
        let connection = memory();

        let before = query(&connection, "pragma synchronous", &[], false).unwrap();
        assert!(before["rows"][0]["synchronous"].is_number());

        execute(&connection, "pragma synchronous = FULL", &[], false).unwrap();
        let after = query(&connection, "pragma synchronous", &[], false).unwrap();
        // 2 is FULL; 1 is NORMAL.
        assert_eq!(after["rows"][0]["synchronous"], json!(2));
    }

    #[test]
    fn a_snapshot_is_a_database_that_opens_on_its_own() {
        let directory =
            std::env::temp_dir().join(format!("vantail-db-test-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let copy = directory.join("copy.sqlite");

        let connection = memory();
        connection
            .execute_batch("create table t(v text); insert into t values ('kept');")
            .unwrap();

        snapshot(&connection, &copy).unwrap();

        let reopened = Connection::open(&copy).unwrap();
        let value: String = reopened
            .query_row("select v from t", [], |row| row.get(0))
            .unwrap();
        assert_eq!(value, "kept");

        std::fs::remove_dir_all(&directory).ok();
    }
}
