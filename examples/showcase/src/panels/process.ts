import { process as proc } from "@vantail/api";
import { panel, type Panel } from "../ui.js";

/**
 * Running other programs.
 *
 * There is no shell involved, so nothing an argument could inject into. The
 * config still pins which programs are allowed, because the narrower the rule
 * the less an injected script could do with it.
 */
export function processPanel(): Panel {
  const p = panel("process", "process", "Running another program, and streaming its output.");

  const text = p.input("argument", "hello from the runtime");
  p.row(
    text,
    p.button("execute()", () => proc.execute("/bin/echo", [text.value])),
  );

  let child: Awaited<ReturnType<typeof proc.spawn>> | null = null;
  p.row(
    p.button("spawn()", async () => {
      child = await proc.spawn("/bin/echo", ["streamed", "a", "line", "at", "a", "time"]);
      child.onStdout((line) => p.log(`out: ${line}`));
      child.onStderr((line) => p.log(`err: ${line}`));
      child.onExit((status) => p.log(`exited with ${status.code}`));
      return `spawned pid ${child.pid}`;
    }),
    p.button("kill()", () => child?.kill() ?? "nothing running"),
    p.button("list()", () => proc.list()),
  );

  p.row(p.button("run something not allowed", () => proc.execute("/bin/ls", ["/"])));
  p.note("Only /bin/echo is in the config's allow list, so /bin/ls is refused before it starts.");

  return p;
}
