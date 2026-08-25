<script lang="ts">
  import { app, dialog, filesystem, VantailError } from "@vantail/api";

  let contents = $state<string | null>(null);
  let path = $state<string | null>(null);
  let error = $state<string | null>(null);

  const info = app.infoSync();

  async function open() {
    error = null;
    try {
      const picked = await dialog.openFile({ title: "Open a text file" });
      if (!picked) return;

      // Picking the file in the dialog is what grants access to it - the
      // config above never mentions this path.
      path = picked;
      contents = await filesystem.readText(picked);
    } catch (cause) {
      error = VantailError.is(cause) ? `${cause.code}: ${cause.message}` : String(cause);
    }
  }
</script>

<main>
  <h1>{info?.name ?? "Vantail"}</h1>
  <p class="meta">v{info?.version}</p>

  <button onclick={() => void open()}>Select file</button>

  {#if error}<p class="error">{error}</p>{/if}
  {#if path}<p class="meta">{path}</p>{/if}
  {#if contents !== null}<pre>{contents}</pre>{:else}<p class="meta">No file open.</p>{/if}
</main>
