import { dialog, filesystem } from "@vantail/api";
import { panel, type Panel } from "../ui.js";

/**
 * The native pickers.
 *
 * Worth knowing: a path the user chooses here is readable for the rest of the
 * session, whatever the config's filesystem scope says. The user's choice is
 * the authorisation, which is what lets a real app keep its standing scope
 * narrow. `filesystem.grantFromDialog: false` turns that off.
 */
export function dialogPanel(): Panel {
  const p = panel("dialog", "dialog", "Native file pickers, alerts and confirmations.");

  p.row(
    p.button("openFile()", () => dialog.openFile()),
    p.button("openFiles()", () => dialog.openFiles()),
    p.button("openDirectory()", () => dialog.openDirectory()),
  );

  p.row(
    p.button("openFile() filtered", () =>
      dialog.openFile({
        title: "Pick an image",
        filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif"] }],
      }),
    ),
    p.button("saveFile()", () => dialog.saveFile({ defaultPath: "notes.txt" })),
  );

  p.row(
    p.button("message()", () => dialog.message("The runtime drew this, not the page.")),
    p.button("confirm()", async () => {
      const yes = await dialog.confirm("Does this look native to you?");
      return yes ? "they said yes" : "they said no";
    }),
  );

  // Proof of the session grant: pick anything, anywhere, and it reads.
  p.row(
    p.button("pick, then read it", async () => {
      const path = await dialog.openFile();
      if (!path) return "cancelled";
      const text = await filesystem.readText(path);
      return `${path}\n\n${text.slice(0, 600)}`;
    }),
  );
  p.note("That reads a file outside the configured scope, and works: picking it granted it.");

  return p;
}
