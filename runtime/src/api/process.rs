//! `process.*` - running other programs.
//!
//! There is no shell anywhere in this module. A program is named exactly as
//! the allow list names it and its arguments are passed as a vector straight
//! to `execve`, so there is never a command string for something else to
//! re-parse. That removes the entire category of shell injection rather than
//! trying to escape its way out of it.
//!
//! Waiting for a child happens on a thread of its own rather than on the
//! worker pool, so a long-running process cannot starve filesystem calls.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::{ApiError, ApiResult};
use crate::ipc::{Event, Outgoing, Request, Response};
use crate::state::{MainCtx, Runtime};

/// How much output is read from a pipe at a time before it is delivered.
const CHUNK: usize = 8 * 1024;

/// How often a waiting thread checks whether its child has finished.
const POLL_MS: u64 = 25;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunParams {
    program: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    env: HashMap<String, String>,
    /// Start from an empty environment instead of inheriting this process's.
    #[serde(default)]
    clear_env: bool,
    /// Written to the child's stdin, which is then closed. `execute` only.
    #[serde(default)]
    stdin: Option<String>,
    /// Kill the child after this long. `execute` only.
    #[serde(default)]
    timeout_ms: Option<u64>,
}

#[derive(Deserialize)]
struct IdParams {
    id: u32,
}

#[derive(Deserialize)]
struct WriteParams {
    id: u32,
    data: String,
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

struct Running {
    program: String,
    pid: u32,
    child: Arc<Mutex<Child>>,
    stdin: Mutex<Option<ChildStdin>>,
}

/// The processes this application has started.
///
/// Handles are ids we allocate rather than OS pids, because a pid can be
/// recycled the moment a process exits and an application holding a stale one
/// must not be able to signal somebody else's process.
#[derive(Default)]
pub struct Registry {
    next: AtomicU32,
    running: Mutex<HashMap<u32, Arc<Running>>>,
}

impl Registry {
    fn insert(
        &self,
        program: String,
        pid: u32,
        child: Arc<Mutex<Child>>,
        stdin: Option<ChildStdin>,
    ) -> u32 {
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        self.running
            .lock()
            .expect("process registry poisoned")
            .insert(
                id,
                Arc::new(Running {
                    program,
                    pid,
                    child,
                    stdin: Mutex::new(stdin),
                }),
            );
        id
    }

    fn get(&self, id: u32) -> Option<Arc<Running>> {
        self.running
            .lock()
            .expect("process registry poisoned")
            .get(&id)
            .cloned()
    }

    fn remove(&self, id: u32) {
        self.running
            .lock()
            .expect("process registry poisoned")
            .remove(&id);
    }

    fn list(&self) -> Vec<Value> {
        self.running
            .lock()
            .expect("process registry poisoned")
            .iter()
            .map(
                |(id, running)| json!({ "id": id, "pid": running.pid, "program": running.program }),
            )
            .collect()
    }

    /// Stop everything we started.
    ///
    /// Called as the runtime shuts down: a child outliving the app that
    /// launched it is a surprise nobody wants.
    pub fn kill_all(&self) {
        let running = std::mem::take(&mut *self.running.lock().expect("process registry poisoned"));
        for (_, entry) in running {
            if let Ok(mut child) = entry.child.lock() {
                let _ = child.kill();
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/// `None` means the response will arrive later, from the thread waiting on
/// the child.
pub fn dispatch(ctx: &mut MainCtx<'_>, id: &str, method: &str, params: Value) -> Option<ApiResult> {
    let rt = ctx.rt.clone();
    let source = ctx.source.to_string();

    Some(match method {
        "process.execute" => match execute(&rt, id, &source, params) {
            Ok(()) => return None,
            Err(error) => Err(error),
        },
        "process.spawn" => spawn(&rt, &source, params),
        "process.write" => write_stdin(&rt, method, params),
        "process.closeStdin" => close_stdin(&rt, method, params),
        "process.kill" => kill(&rt, method, params),
        "process.list" => Ok(Value::Array(rt.processes.list())),
        _ => Err(ApiError::unknown_method(method)),
    })
}

fn execute(
    rt: &Arc<Runtime>,
    request_id: &str,
    source: &str,
    params: Value,
) -> Result<(), ApiError> {
    let params: RunParams = Request::params("process.execute", params)?;
    let mut command = prepare(rt, &params)?;

    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    command.stdin(if params.stdin.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    });

    let mut child = command
        .spawn()
        .map_err(|e| ApiError::io(&format!("Could not start `{}`", params.program), e))?;

    if let (Some(input), Some(mut pipe)) = (params.stdin.clone(), child.stdin.take()) {
        // Written and closed before waiting, so a child that reads all of
        // stdin before writing anything cannot deadlock against us.
        let _ = pipe.write_all(input.as_bytes());
        drop(pipe);
    }

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let child = Arc::new(Mutex::new(child));
    let pid = child.lock().expect("child poisoned").id();
    let id = rt
        .processes
        .insert(params.program.clone(), pid, Arc::clone(&child), None);

    if let Some(after) = params.timeout_ms {
        watchdog(Arc::clone(&child), after);
    }

    let rt = Arc::clone(rt);
    let request_id = request_id.to_string();
    let source = source.to_string();

    thread(format!("vantail-exec-{id}"), move || {
        // Two readers, because a child that fills one pipe while we drain the
        // other would block forever.
        let out = reader_thread(stdout);
        let err = reader_thread(stderr);

        let status = wait_for(&child);
        rt.processes.remove(id);

        let result = match status {
            Ok(status) => Ok(json!({
                "code": status.code(),
                "signal": signal_of(&status),
                "success": status.success(),
                "stdout": out.join(),
                "stderr": err.join(),
            })),
            Err(error) => Err(ApiError::io("The process could not be waited on", error)),
        };

        rt.send(
            Some(source),
            Outgoing::Response(Response::from_result(request_id, result)),
        );
    });

    Ok(())
}

fn spawn(rt: &Arc<Runtime>, source: &str, params: Value) -> ApiResult {
    let params: RunParams = Request::params("process.spawn", params)?;
    let mut command = prepare(rt, &params)?;

    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|e| ApiError::io(&format!("Could not start `{}`", params.program), e))?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stdin = child.stdin.take();

    let child = Arc::new(Mutex::new(child));
    let pid = child.lock().expect("child poisoned").id();
    let id = rt
        .processes
        .insert(params.program.clone(), pid, Arc::clone(&child), stdin);

    stream(rt, source, id, "process.stdout", stdout);
    stream(rt, source, id, "process.stderr", stderr);

    let rt_for_wait = Arc::clone(rt);
    let source_for_wait = source.to_string();
    thread(format!("vantail-wait-{id}"), move || {
        let status = wait_for(&child);
        rt_for_wait.processes.remove(id);
        rt_for_wait.send(
            Some(source_for_wait),
            Outgoing::Event(Event::new(
                "process.exit",
                match status {
                    Ok(status) => json!({
                        "id": id,
                        "code": status.code(),
                        "signal": signal_of(&status),
                        "success": status.success(),
                    }),
                    Err(error) => json!({ "id": id, "code": null, "error": error.to_string() }),
                },
            )),
        );
    });

    Ok(json!({ "id": id, "pid": pid }))
}

fn write_stdin(rt: &Runtime, method: &str, params: Value) -> ApiResult {
    let WriteParams { id, data } = Request::params(method, params)?;
    let running = rt.processes.get(id).ok_or_else(|| gone(id))?;

    let mut slot = running.stdin.lock().expect("stdin poisoned");
    let pipe = slot
        .as_mut()
        .ok_or_else(|| ApiError::new(crate::error::code::IO_ERROR, "stdin is already closed"))?;

    pipe.write_all(data.as_bytes())
        .and_then(|()| pipe.flush())
        .map(|()| Value::Null)
        .map_err(|e| ApiError::io("Could not write to the process", e))
}

fn close_stdin(rt: &Runtime, method: &str, params: Value) -> ApiResult {
    let IdParams { id } = Request::params(method, params)?;
    let running = rt.processes.get(id).ok_or_else(|| gone(id))?;
    running.stdin.lock().expect("stdin poisoned").take();
    Ok(Value::Null)
}

fn kill(rt: &Runtime, method: &str, params: Value) -> ApiResult {
    let IdParams { id } = Request::params(method, params)?;
    let running = rt.processes.get(id).ok_or_else(|| gone(id))?;

    let killed = running.child.lock().expect("child poisoned").kill();
    killed
        .map(|()| Value::Null)
        .map_err(|e| ApiError::io("Could not stop the process", e))
}

fn gone(id: u32) -> ApiError {
    ApiError::new(
        crate::error::code::NOT_FOUND,
        format!("No running process with id {id}"),
    )
}

// ---------------------------------------------------------------------------
// Building the command
// ---------------------------------------------------------------------------

fn prepare(rt: &Runtime, params: &RunParams) -> Result<Command, ApiError> {
    let rule = rt
        .permissions
        .check_program(&params.program, &params.args)?;

    let mut command = Command::new(resolve_program(rt, &params.program));
    command.args(&params.args);

    if let Some(cwd) = &params.cwd {
        command.current_dir(rt.permissions.check_cwd(rule, cwd)?);
    }
    if params.clear_env {
        command.env_clear();
    }
    for (key, value) in &params.env {
        command.env(key, value);
    }

    Ok(command)
}

/// `$RESOURCE/bin/tool` names a sidecar shipped inside the app bundle.
/// Anything else is passed through untouched, so a bare name is resolved on
/// `PATH` exactly as the shell would resolve it.
fn resolve_program(rt: &Runtime, program: &str) -> std::path::PathBuf {
    match program.strip_prefix("$RESOURCE/") {
        Some(rest) => rt.resource_dir.join(rest),
        None => std::path::PathBuf::from(program),
    }
}

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

/// Read a pipe to the end on its own thread, delivering chunks as they come.
///
/// Chunks rather than lines: a program drawing a progress bar with `\r` never
/// emits a newline, and would otherwise look like it had hung.
fn stream<R: Read + Send + 'static>(
    rt: &Arc<Runtime>,
    source: &str,
    id: u32,
    event: &'static str,
    pipe: Option<R>,
) {
    let Some(mut pipe) = pipe else { return };
    let rt = Arc::clone(rt);
    let source = source.to_string();

    thread(format!("vantail-{event}-{id}"), move || {
        let mut buffer = [0_u8; CHUNK];
        loop {
            match pipe.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    let data = String::from_utf8_lossy(&buffer[..read]).into_owned();
                    rt.send(
                        Some(source.clone()),
                        Outgoing::Event(Event::new(event, json!({ "id": id, "data": data }))),
                    );
                }
            }
        }
    });
}

/// A thread that collects a whole pipe, for `execute`.
struct Collector(Option<std::thread::JoinHandle<String>>);

impl Collector {
    fn join(self) -> String {
        self.0
            .and_then(|handle| handle.join().ok())
            .unwrap_or_default()
    }
}

fn reader_thread<R: Read + Send + 'static>(pipe: Option<R>) -> Collector {
    let Some(mut pipe) = pipe else {
        return Collector(None);
    };
    Collector(
        std::thread::Builder::new()
            .name("vantail-collect".into())
            .spawn(move || {
                let mut buffer = Vec::new();
                let _ = pipe.read_to_end(&mut buffer);
                String::from_utf8_lossy(&buffer).into_owned()
            })
            .ok(),
    )
}

/// Wait for a child, polling rather than blocking.
///
/// `Child::wait` would hold the mutex for the whole life of the process,
/// which would make `process.kill` - and the timeout below - wait for the
/// very thing they are trying to interrupt. Polling releases the lock between
/// checks so both stay possible.
fn wait_for(child: &Mutex<Child>) -> std::io::Result<std::process::ExitStatus> {
    loop {
        match child.lock().expect("child poisoned").try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(POLL_MS)),
            Err(error) => return Err(error),
        }
    }
}

fn watchdog(child: Arc<Mutex<Child>>, after_ms: u64) {
    thread("vantail-timeout".to_string(), move || {
        std::thread::sleep(std::time::Duration::from_millis(after_ms));
        if let Ok(mut child) = child.lock() {
            // Killing an already-finished child is a no-op, not a problem.
            let _ = child.kill();
        }
    });
}

fn thread(name: String, body: impl FnOnce() + Send + 'static) {
    // A thread we cannot start means the process is in trouble anyway; the
    // caller sees a timeout rather than a wrong answer.
    let _ = std::thread::Builder::new().name(name).spawn(body);
}

#[cfg(unix)]
fn signal_of(status: &std::process::ExitStatus) -> Option<i32> {
    use std::os::unix::process::ExitStatusExt;
    status.signal()
}

#[cfg(not(unix))]
fn signal_of(_status: &std::process::ExitStatus) -> Option<i32> {
    None
}
