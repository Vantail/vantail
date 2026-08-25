<script setup lang="ts">
import { ref } from "vue";

import { app, dialog, filesystem, VantailError } from "@vantail/api";

const contents = ref<string | null>(null);
const path = ref<string | null>(null);
const error = ref<string | null>(null);

const info = app.infoSync();

async function open() {
  error.value = null;
  try {
    const picked = await dialog.openFile({ title: "Open a text file" });
    if (!picked) return;

    // Picking the file in the dialog is what grants access to it - the
    // config above never mentions this path.
    path.value = picked;
    contents.value = await filesystem.readText(picked);
  } catch (cause) {
    error.value = VantailError.is(cause) ? `${cause.code}: ${cause.message}` : String(cause);
  }
}
</script>

<template>
  <main>
    <h1>{{ info?.name ?? "Vantail" }}</h1>
    <p class="meta">v{{ info?.version }}</p>

    <button @click="open">Select file</button>

    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="path" class="meta">{{ path }}</p>
    <pre v-if="contents !== null">{{ contents }}</pre>
    <p v-else class="meta">No file open.</p>
  </main>
</template>
