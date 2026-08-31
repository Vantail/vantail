/**
 * Enough of an application to give the title bar something to sit on top of.
 *
 * The bar is the point of this example; everything below it is scenery, and
 * deliberately plain CSS grid so that resizing the window is the browser's
 * problem rather than React's.
 */

import { useEffect, useState } from "react";

import { menu } from "@vantail/api";

import { appMenu, REPEAT, SHUFFLE } from "./menu.js";
import { TitleBar } from "./TitleBar.js";

const LIBRARY = [
  "Liked Songs",
  "Daily Mix 1",
  "Daily Mix 2",
  "Release Radar",
  "Discover Weekly",
  "On Repeat",
  "Recently Played",
];

const SHELF = [
  "Daily Mix 1",
  "Daily Mix 2",
  "Discover Weekly",
  "Release Radar",
  "On Repeat",
  "Repeat Rewind",
];

export function App() {
  // The two menu items that show a state rather than doing something. They
  // live here because the menu is rebuilt from them: a menu is a snapshot, so
  // a tick that is not passed back in is a tick that resets itself.
  const [shuffle, setShuffle] = useState(false);
  const [repeat, setRepeat] = useState(false);

  useEffect(
    () =>
      menu.onClick(({ id }) => {
        if (id === SHUFFLE) setShuffle((on) => !on);
        if (id === REPEAT) setRepeat((on) => !on);
      }),
    [],
  );

  return (
    <div className="app">
      <TitleBar menu={appMenu({ shuffle, repeat })} />

      <div className="body">
        <aside className="library">
          <h2>Your Library</h2>
          <ul>
            {LIBRARY.map((item) => (
              <li key={item}>
                <span className="art" aria-hidden />
                {item}
              </li>
            ))}
          </ul>
        </aside>

        <main>
          <h1>Good evening</h1>
          <div className="shelf">
            {SHELF.map((item) => (
              <article key={item} className="card">
                <span className="art" aria-hidden />
                <h3>{item}</h3>
                <p>Made for you</p>
              </article>
            ))}
          </div>
        </main>
      </div>

      <footer className="now-playing">
        <div className="track">
          <span className="art" aria-hidden />
          <div>
            <p className="title">Nothing playing</p>
            <p className="quiet">Pick something from the shelf</p>
          </div>
        </div>
        <div className="transport">
          <button type="button" aria-label="Play">
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M5 3.5l8 4.5-8 4.5z" fill="currentColor" />
            </svg>
          </button>
          <div className="scrubber" aria-hidden>
            <span />
          </div>
        </div>
        <div className="spacer" />
      </footer>
    </div>
  );
}
