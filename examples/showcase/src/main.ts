/**
 * Every Vantail API, one panel each.
 *
 * The point of this app is coverage rather than beauty: if something is in
 * `@vantail/api`, there is a button for it here. Panels that need hardware or
 * a signed release say so rather than pretending.
 *
 * `vantail.config.ts` grants every permission, which no real application
 * should do. It is what lets one app demonstrate all of them.
 */

import "./style.css";

import { isVantail, runtimeVersion } from "@vantail/api";
import { mountTitleBar } from "./titlebar.js";

import { appPanel } from "./panels/app.js";
import { clipboardPanel } from "./panels/clipboard.js";
import { deepLinkPanel, dropPanel, updaterPanel } from "./panels/updater.js";
import { dialogPanel } from "./panels/dialog.js";
import { filesystemPanel } from "./panels/filesystem.js";
import { hidPanel, mdnsPanel, secretsPanel } from "./panels/devices.js";
import { menuPanel } from "./panels/menu.js";
import { databasePanel } from "./panels/database.js";
import { networkPanel } from "./panels/network.js";
import { osPanel } from "./panels/os.js";
import { processPanel } from "./panels/process.js";
import { rawPanel } from "./panels/raw.js";
import { screenPanel } from "./panels/screen.js";
import {
  autostartPanel,
  notificationPanel,
  powerPanel,
  shellPanel,
  shortcutPanel,
} from "./panels/system.js";
import { trayPanel } from "./panels/tray.js";
import { windowPanel } from "./panels/window.js";
import type { Panel } from "./ui.js";

const nav = document.querySelector<HTMLElement>("#nav");
const main = document.querySelector<HTMLElement>("#main");

if (!nav || !main) throw new Error("The page is missing #nav or #main");

// Opened outside Vantail - `npm run dev` in a browser, say - none of this
// exists. Saying so beats a page full of NO_RUNTIME failures.
if (!isVantail()) {
  main.innerHTML =
    "<section class='panel'><h2>Not running under Vantail</h2>" +
    "<p class='blurb'>This page is open in a plain browser, where none of the " +
    "native APIs exist. Run <code>vantail dev</code> instead.</p></section>";
} else {
  build();
}

function build() {
  // The app's own title bar, shown only while the platform's is hidden.
  mountTitleBar();

  const panels: Panel[] = [
    appPanel(),
    windowPanel(),
    screenPanel(),
    osPanel(),
    filesystemPanel(),
    dialogPanel(),
    dropPanel(),
    clipboardPanel(),
    menuPanel(),
    trayPanel(),
    notificationPanel(),
    shortcutPanel(),
    autostartPanel(),
    powerPanel(),
    shellPanel(),
    processPanel(),
    networkPanel(),
    databasePanel(),
    secretsPanel(),
    mdnsPanel(),
    hidPanel(),
    updaterPanel(),
    deepLinkPanel(),
    rawPanel(),
  ];

  const version = document.createElement("p");
  version.className = "runtime";
  version.textContent = `runtime ${runtimeVersion() ?? "unknown"}`;
  nav!.append(version);

  const links = new Map<string, HTMLAnchorElement>();

  for (const item of panels) {
    main!.append(item.root);

    const link = document.createElement("a");
    link.href = `#panel-${item.id}`;
    link.textContent = item.title;
    link.addEventListener("click", (event) => {
      event.preventDefault();
      item.root.scrollIntoView({ behavior: "smooth", block: "start" });
      select(item.id);
    });
    links.set(item.id, link);
    nav!.append(link);
  }

  function select(id: string) {
    for (const [key, link] of links) link.classList.toggle("active", key === id);
  }

  // Whichever panel is nearest the top of the viewport is the one the
  // sidebar highlights.
  const spy = new IntersectionObserver(
    (entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (visible) select(visible.target.id.replace("panel-", ""));
    },
    { rootMargin: "-10% 0px -80% 0px" },
  );
  for (const item of panels) spy.observe(item.root);

  select(panels[0]!.id);
}
