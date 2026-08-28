import { decode, encode, type BinaryInput } from "./binary.js";
import { invoke } from "./transport.js";

/** Everything SQLite can hold, as JavaScript sees it. */
export type DatabaseValue = null | number | bigint | string | Uint8Array;

/** What a statement can be given. Booleans are stored as 0 and 1. */
export type DatabaseParam = DatabaseValue | boolean | BinaryInput;

export type DatabaseRow = Record<string, DatabaseValue>;

export interface StatementOptions {
  /**
   * Read every INTEGER as a `bigint`.
   *
   * Without it an integer that a JavaScript number cannot hold exactly is an
   * error rather than a rounded answer - which is the point. SQLite's INTEGER
   * is 64-bit and a JavaScript number is a double, so anything past
   * 2^53 silently loses its low bits; for a balance in minor units, that is
   * money. Turn this on for tables whose ids or amounts can get large, and
   * the numbers come back exact.
   */
  bigint?: boolean;
}

export interface DatabaseExecuteResult {
  /** Rows inserted, updated or deleted. */
  changes: number;
  /** Only meaningful straight after an INSERT. */
  lastInsertRowId: number | bigint;
}

/** The statements inside a `transaction` callback. */
export interface Transaction {
  query<Row extends DatabaseRow = DatabaseRow>(
    sql: string,
    params?: DatabaseParam[],
    options?: StatementOptions,
  ): Promise<Row[]>;
  execute(
    sql: string,
    params?: DatabaseParam[],
    options?: StatementOptions,
  ): Promise<DatabaseExecuteResult>;
}

export interface Database {
  /** The handle the runtime knows this connection by. */
  readonly id: number;
  /** The file, resolved - `$APPDATA` and friends already expanded. */
  readonly path: string;

  /** Rows back. */
  query<Row extends DatabaseRow = DatabaseRow>(
    sql: string,
    params?: DatabaseParam[],
    options?: StatementOptions,
  ): Promise<Row[]>;

  /** No rows; a count of what changed. */
  execute(
    sql: string,
    params?: DatabaseParam[],
    options?: StatementOptions,
  ): Promise<DatabaseExecuteResult>;

  /**
   * Run several statements atomically.
   *
   * Committed when `run` resolves, rolled back when it throws. SQLite has one
   * write transaction per connection and so does this: callers that overlap
   * wait their turn rather than joining an open `BEGIN`, because sharing one
   * means a rollback in either discards the other's writes.
   *
   * Do only database work inside `run`. The transaction holds the connection
   * for as long as the callback takes, and a transaction left idle for 30
   * seconds is rolled back so a callback that never settles cannot wedge the
   * connection for the life of the process.
   *
   * ```ts
   * await db.transaction(async (tx) => {
   *   await tx.execute("update account set minor = minor - ? where id = ?", [amount, from]);
   *   await tx.execute("update account set minor = minor + ? where id = ?", [amount, to]);
   * });
   * ```
   */
  transaction<T>(run: (tx: Transaction) => Promise<T>): Promise<T>;

  /**
   * Fold the write-ahead log back into the database file.
   *
   * Worth doing before copying the file out by hand. `snapshot` does not need
   * it - SQLite's backup API takes care of itself.
   */
  checkpoint(): Promise<null>;

  /**
   * Write a consistent copy to another path, which must also be writable.
   *
   * SQLite's own backup API, not a file copy: it is safe to call while the
   * database is being written to, which `filesystem.copy` is not.
   */
  snapshot(path: string): Promise<{ path: string }>;

  close(): Promise<null>;
}

export interface OpenOptions {
  /** Where the file lives. Needs `filesystem.write` scope, or read for `readOnly`. */
  path: string;
  /** Open an existing database without being able to change it. */
  readOnly?: boolean;
}

/**
 * SQLite, from the runtime.
 *
 * A webview can run SQLite compiled to WebAssembly, and applications do. What
 * it cannot do is give the database anywhere real to live: persisting it means
 * writing the whole file out on every commit, and keeping it in the origin's
 * private storage instead means the user cannot find, copy or back up their
 * own data. This is the same file, written by SQLite itself - journalled,
 * incremental, and sitting in a directory the config granted.
 *
 * ```ts
 * import { database, os, path } from "@vantail/api";
 *
 * const db = await database.open({
 *   path: path.join(await os.appDataDir(), "ledger.sqlite"),
 * });
 *
 * await db.execute(
 *   "create table if not exists entry(id integer primary key, minor integer not null)",
 * );
 * const rows = await db.query<{ id: number; minor: bigint }>(
 *   "select id, minor from entry where minor > ?",
 *   [0],
 *   { bigint: true },
 * );
 * ```
 *
 * Connections are opened with WAL journalling, `synchronous = NORMAL` and
 * `foreign_keys = ON`, so a declared foreign key is actually enforced - SQLite
 * leaves that off by default for compatibility with 2005.
 *
 * There is no encryption. `secrets` will hold a key, but there is nothing here
 * to give it to; say so plainly in your UI rather than showing a padlock that
 * means nothing.
 */
export const database = {
  open: async (options: OpenOptions): Promise<Database> => {
    const opened = await invoke<{ id: number; path: string }>(
      "database.open",
      options,
    );
    return connect(opened.id, opened.path);
  },
};

function connect(id: number, path: string): Database {
  const query = async <Row extends DatabaseRow>(
    sql: string,
    params: DatabaseParam[] = [],
    options: StatementOptions = {},
    transaction?: number,
  ): Promise<Row[]> => {
    const result = await invoke<{ rows: Record<string, unknown>[] }>(
      "database.query",
      {
        id,
        sql,
        params: params.map(toWire),
        bigint: options.bigint === true,
        ...(transaction === undefined ? {} : { transaction }),
      },
    );
    return result.rows.map(fromWireRow) as Row[];
  };

  const execute = async (
    sql: string,
    params: DatabaseParam[] = [],
    options: StatementOptions = {},
    transaction?: number,
  ): Promise<DatabaseExecuteResult> => {
    const result = await invoke<{
      changes: number;
      lastInsertRowId: unknown;
    }>("database.execute", {
      id,
      sql,
      params: params.map(toWire),
      bigint: options.bigint === true,
      ...(transaction === undefined ? {} : { transaction }),
    });
    return {
      changes: result.changes,
      lastInsertRowId: fromWire(result.lastInsertRowId) as number | bigint,
    };
  };

  return {
    id,
    path,

    query: (sql, params, options) => query(sql, params, options),
    execute: (sql, params, options) => execute(sql, params, options),

    async transaction(run) {
      const { transaction } = await invoke<{ transaction: number }>(
        "database.begin",
        { id },
      );

      let result;
      try {
        result = await run({
          query: (sql, params, options) =>
            query(sql, params, options, transaction),
          execute: (sql, params, options) =>
            execute(sql, params, options, transaction),
        });
      } catch (cause) {
        // Rolling back must not replace the error that caused it - the
        // application needs to see why its work was abandoned.
        await invoke("database.rollback", { id, transaction }).catch(() => {});
        throw cause;
      }

      await invoke("database.commit", { id, transaction });
      return result;
    },

    checkpoint: () => invoke<null>("database.checkpoint", { id }),
    snapshot: (to) =>
      invoke<{ path: string }>("database.snapshot", { id, path: to }),
    close: () => invoke<null>("database.close", { id }),
  };
}

/**
 * JSON has no 64-bit integer and no byte string, so both are tagged.
 *
 * The alternative - numbers for everything - is what silently truncates a
 * balance, so the tag is the point rather than an inconvenience.
 */
function toWire(value: DatabaseParam): unknown {
  if (typeof value === "bigint") return { $bigint: value.toString() };
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
    return { $blob: encode(value as BinaryInput) };
  }
  return value;
}

function fromWire(value: unknown): DatabaseValue {
  if (value !== null && typeof value === "object") {
    const tagged = value as { $bigint?: unknown; $blob?: unknown };
    if (typeof tagged.$bigint === "string") return BigInt(tagged.$bigint);
    if (typeof tagged.$blob === "string") return decode(tagged.$blob);
  }
  return value as DatabaseValue;
}

function fromWireRow(row: Record<string, unknown>): DatabaseRow {
  const out: DatabaseRow = {};
  for (const [column, value] of Object.entries(row)) {
    out[column] = fromWire(value);
  }
  return out;
}
