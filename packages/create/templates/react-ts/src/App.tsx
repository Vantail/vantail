import { useState } from "react";

import { app, dialog, filesystem, VantailError } from "@vantail/api";

export function App() {
  const [contents, setContents] = useState<string | null>(null);
  const [path, setPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const info = app.infoSync();

  async function open() {
    setError(null);
    try {
      const picked = await dialog.openFile({ title: "Open a text file" });
      if (!picked) return;

      // Picking the file in the dialog is what grants access to it - the
      // config above never mentions this path.
      setPath(picked);
      setContents(await filesystem.readText(picked));
    } catch (cause) {
      setError(VantailError.is(cause) ? `${cause.code}: ${cause.message}` : String(cause));
    }
  }

  return (
    <main>
      <h1>{info?.name ?? "Vantail"}</h1>
      <p className="meta">v{info?.version}</p>

      <button onClick={() => void open()}>Select file</button>

      {error ? <p className="error">{error}</p> : null}
      {path ? <p className="meta">{path}</p> : null}
      {contents !== null ? <pre>{contents}</pre> : <p className="meta">No file open.</p>}
    </main>
  );
}
