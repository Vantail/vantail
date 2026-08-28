import { database, os, path, type Database } from "@vantail/api";
import { panel, type Panel } from "../ui.js";

/**
 * SQLite, in a real file the user owns.
 *
 * The interesting part is not that queries work. It is the integer rule: a
 * value past 2^53 is refused rather than rounded, which is the difference
 * between a ledger and a rough idea of a ledger.
 */
export function databasePanel(): Panel {
  const p = panel("database", "database", "SQLite in a file you can find, copy and back up.");

  let open: Database | undefined;

  const connection = async (): Promise<Database> => {
    if (open) return open;
    open = await database.open({
      path: path.join(await os.appDataDir(), "showcase.sqlite"),
    });
    await open.execute(
      "create table if not exists entry(id integer primary key, minor integer not null, note text)",
    );
    return open;
  };

  p.row(
    p.button("open()", async () => {
      const db = await connection();
      return { id: db.id, path: db.path };
    }),
    p.button("insert a row", async () => {
      const db = await connection();
      return db.execute("insert into entry(minor, note) values (?, ?)", [
        1250,
        new Date().toISOString(),
      ]);
    }),
    p.button("query()", async () => {
      const db = await connection();
      return db.query("select id, minor, note from entry order by id desc limit 5");
    }),
  );

  p.row(
    p.button("store 2^53 + 1", async () => {
      const db = await connection();
      await db.execute("insert into entry(minor, note) values (?, ?)", [
        9007199254740993n,
        "too big for a number",
      ]);
      return db.query(
        "select minor from entry where note = ?",
        ["too big for a number"],
        { bigint: true },
      );
    }),
    p.button("read it as a number", async () => {
      const db = await connection();
      // Refused rather than rounded - which is the whole point.
      return db.query("select minor from entry where note = ?", [
        "too big for a number",
      ]);
    }),
  );
  p.note("SQLite's INTEGER is 64-bit and a JS number is a double. Reading one that does not fit is an error naming the column, never a rounded answer.");

  p.row(
    p.button("transaction that commits", async () => {
      const db = await connection();
      await db.transaction(async (tx) => {
        await tx.execute("insert into entry(minor, note) values (?, ?)", [1, "kept"]);
      });
      return db.query("select count(*) as kept from entry where note = ?", ["kept"]);
    }),
    p.button("transaction that throws", async () => {
      const db = await connection();
      const before = await db.query("select count(*) as n from entry");
      await db
        .transaction(async (tx) => {
          await tx.execute("insert into entry(minor, note) values (?, ?)", [1, "doomed"]);
          throw new Error("changed my mind");
        })
        .catch(() => undefined);
      const after = await db.query("select count(*) as n from entry");
      return { before: before[0].n, after: after[0].n, rolledBack: true };
    }),
  );

  p.row(
    p.button("checkpoint()", async () => {
      const db = await connection();
      await db.checkpoint();
      return "write-ahead log folded back in";
    }),
    p.button("snapshot()", async () => {
      const db = await connection();
      return db.snapshot(path.join(await os.appDataDir(), "showcase-backup.sqlite"));
    }),
    p.button("close()", async () => {
      const db = await connection();
      await db.close();
      open = undefined;
      return "closed";
    }),
  );
  p.note("snapshot() is SQLite's own backup API, safe to call while the database is being written to - which is what makes 'back up your data' a real feature rather than a copy that might be torn.");

  return p;
}
