import { invoke, listen } from "./transport.js";

export interface UpdateAvailable {
  available: true;
  currentVersion: string;
  version: string;
  notes: string | null;
  pubDate: string | null;
  target: string;
}

export interface NoUpdate {
  available: false;
  currentVersion: string;
}

export type UpdateCheck = UpdateAvailable | NoUpdate;

export interface DownloadProgress {
  downloaded: number;
  /** `0` when the server did not send a content length. */
  total: number;
}

export interface DownloadResult {
  ready: true;
  version: string;
  bytes: number;
}

/**
 * Replacing the application with a newer one.
 *
 * Three steps rather than one, because they fail for different reasons and an
 * application usually wants to say something different about each: `check` is
 * a network call, `download` can take minutes and reports progress, and
 * `install` restarts the app.
 *
 * Nothing is extracted before its signature has been checked against the
 * public key in `vantail.config.ts`, so whoever controls the update endpoint
 * can stop an update but cannot substitute one.
 *
 * ```ts
 * const update = await updater.check();
 * if (update.available && await dialog.confirm(`Install ${update.version}?`)) {
 *   await updater.downloadAndInstall((p) => setProgress(p.downloaded / p.total));
 * }
 * ```
 */
export const updater = {
  check: () => invoke<UpdateCheck>("updater.check"),

  /**
   * Download and verify, without installing. Resolves once the archive is on
   * disk and its signature has been checked.
   */
  download: (
    onProgress?: (progress: DownloadProgress) => void,
  ): Promise<DownloadResult> => {
    const stop = onProgress
      ? listen<DownloadProgress>("updater.progress", onProgress)
      : undefined;
    return invoke<DownloadResult>("updater.download").finally(() => stop?.());
  },

  /** Whether a verified update is sitting on disk waiting to be installed. */
  pending: () =>
    invoke<{ ready: boolean; version?: string }>("updater.pending"),

  /**
   * Swap in the downloaded version and relaunch.
   *
   * This never resolves: the process is replaced. Save anything you care
   * about before calling it.
   */
  install: () => invoke<never>("updater.install"),

  downloadAndInstall: async (
    onProgress?: (progress: DownloadProgress) => void,
  ) => {
    await updater.download(onProgress);
    return updater.install();
  },

  onProgress: (handler: (progress: DownloadProgress) => void) =>
    listen<DownloadProgress>("updater.progress", handler),
};
