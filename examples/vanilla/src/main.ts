import { app, dialog, filesystem, VantailError } from "@vantail/api";

import "./style.css";

const openButton = document.querySelector<HTMLButtonElement>("#open")!;
const errorLine = document.querySelector<HTMLParagraphElement>("#error")!;
const pathLine = document.querySelector<HTMLParagraphElement>("#path")!;
const contents = document.querySelector<HTMLPreElement>("#contents")!;
const version = document.querySelector<HTMLParagraphElement>("#version")!;

// Injected before any script runs, so no await is needed for app identity.
const info = app.infoSync();
version.textContent = info ? `v${info.version}` : "";

openButton.addEventListener("click", () => {
  void open();
});

async function open(): Promise<void> {
  errorLine.hidden = true;

  try {
    const picked = await dialog.openFile({ title: "Open a text file" });
    if (!picked) return;

    // Picking the file in the dialog is what grants access to it - the
    // config never mentions this path.
    pathLine.textContent = picked;
    contents.textContent = await filesystem.readText(picked);
  } catch (cause) {
    errorLine.hidden = false;
    errorLine.textContent = VantailError.is(cause)
      ? `${cause.code}: ${cause.message}`
      : String(cause);
  }
}
