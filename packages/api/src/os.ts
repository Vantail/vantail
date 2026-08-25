import { bridgeInfo, invoke } from "./transport.js";

export type Platform = "macos" | "windows" | "linux" | (string & {});

export interface OsInfo {
  platform: Platform;
  arch: string;
  family: string;
}

/** Read-only facts about the machine, and the directories an app may use. */
export const os = {
  platform: () => invoke<Platform>("os.platform"),
  arch: () => invoke<string>("os.arch"),
  info: () => invoke<OsInfo>("os.info"),

  homeDir: () => invoke<string>("os.homeDir"),
  tempDir: () => invoke<string>("os.tempDir"),

  /** Per-application data directory, named after `app.identifier`. */
  appDataDir: () => invoke<string>("os.appDataDir"),
  appConfigDir: () => invoke<string>("os.appConfigDir"),

  /** Where the app's own bundled assets live. */
  resourceDir: () => invoke<string>("os.resourceDir"),

  /** Platform and architecture without awaiting; `undefined` in a browser. */
  infoSync: (): Pick<OsInfo, "platform" | "arch"> | undefined => {
    const info = bridgeInfo();
    return info ? { platform: info.platform, arch: info.arch } : undefined;
  },
};
