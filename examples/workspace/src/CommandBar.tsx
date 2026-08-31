/**
 * The dark band across the top: workspace pickers on the leading edge,
 * account and window controls on the trailing one.
 *
 * It is not a bar sitting under the title bar - it *is* the top half of the
 * title bar. Nothing here wires that up: the runtime makes the band a hidden
 * bar left behind draggable on its own, and skips the controls.
 */

import type { TitleBarMetrics } from "@vantail/api";

import { Dropdown } from "./Dropdown.js";
import { Bell, Chevron, Grid, Help, Search } from "./icons.js";
import { WindowControls } from "./WindowControls.js";

export function CommandBar({
  metrics,
  ownControls,
  maximized,
}: {
  metrics: TitleBarMetrics;
  ownControls: boolean;
  maximized: boolean;
}) {
  return (
    <div className="command">
      {/*
        The platform's window buttons are in the top-left corner of the window
        on macOS, which is inside this row. `insetLeft` is how much room they
        need; it is zero everywhere they are not, so this padding costs
        nothing on Windows and Linux.
      */}
      <div className="lead" style={{ paddingLeft: `calc(${metrics.insetLeft}px + 10px)` }}>
        <button type="button" className="bar-button icon" title="All apps">
          <Grid />
        </button>

        <Dropdown label="Workspace" items={["Workspace", "Personal", "Archive"]} />
        <Dropdown label="Vantail Corp" items={["Vantail Corp", "Vantail Labs"]} strong />
        <Dropdown label="All Projects" items={["All Projects", "Recent", "Starred"]} />
      </div>

      <div className="trail">
        <button type="button" className="bar-button icon" title="Search">
          <Search />
        </button>
        <button type="button" className="bar-button icon" title="Notifications">
          <Bell />
        </button>
        <button type="button" className="bar-button icon" title="Help">
          <Help />
        </button>

        <button type="button" className="bar-button account" title="Account">
          <span className="avatar">A</span>
          <Chevron />
        </button>

        {/*
          Only where the platform drew none. On macOS the traffic lights are
          still there, on the other side of this row, and a second set of
          controls beside them would be worse than useless.
        */}
        {ownControls && <WindowControls maximized={maximized} />}
      </div>
    </div>
  );
}
