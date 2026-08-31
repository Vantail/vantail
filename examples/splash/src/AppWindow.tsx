/**
 * The application proper: a title bar this application draws, and a page under
 * it.
 *
 * There is nothing special about this window beyond the options the splash
 * asked for when it opened it - see the handover in `SplashScreen.tsx`.
 */

import { useEffect, useState } from "react";

import { app, appWindow, currentWindow, listWindows } from "@vantail/api";
import { Layers, MoveDiagonal, PanelTop } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { TitleBar } from "@/TitleBar";
import { PLATFORM } from "@/platform";
import { BAR_HEIGHT, drawsOwnControls, useTitleBar } from "@/window";

interface Facts {
  application: string;
  label: string;
  title: string;
  windows: string;
}

export function AppWindow() {
  const metrics = useTitleBar();
  const [facts, setFacts] = useState<Facts>();

  useEffect(() => {
    void (async () => {
      const info = await app.info();
      setFacts({
        application: `${info.name} ${info.version}`,
        label: currentWindow() ?? "unknown",
        title: await appWindow.title(),
        // The splash has closed by now, so this is the only one left.
        windows: (await listWindows()).join(", "),
      });
    })();
  }, []);

  return (
    <div className="flex h-full flex-col">
      <TitleBar title="Splash Example" />

      {/*
        The one scrolling region. `min-h-0` is what lets a flex child actually
        shrink: without it this grows to fit its content, the body's
        `overflow: hidden` clips the bottom off, and there is no way to scroll
        to what was clipped.
      */}
      <main className="min-h-0 flex-1 space-y-4 overflow-y-auto p-6 select-text">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">The application</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            The splash closed itself once this window was open. What it opened was an ordinary
            window asked for three unusual things: no platform title bar, a bar 44 points tall,
            and a background colour to show before any of this had painted.
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <PanelTop className="size-4" aria-hidden="true" />
                What the platform left
              </CardTitle>
              <CardDescription>
                From <code className="text-xs">titleBarMetrics()</code>, read off the injected
                bridge before this page laid out.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-[max-content_1fr] gap-x-5 gap-y-1.5 text-sm">
                <Row term="Platform" value={PLATFORM} />
                <Row term="Reserved height" value={`${metrics.height}px`} />
                <Row term="Leading inset" value={`${metrics.insetLeft}px`} />
                <Row term="Trailing inset" value={`${metrics.insetRight}px`} />
                <Row term="Bar drawn at" value={`${Math.max(BAR_HEIGHT, metrics.height)}px`} />
              </dl>

              <p className="text-muted-foreground mt-4 text-xs">
                {drawsOwnControls(metrics)
                  ? "Nothing was reserved on the leading edge, so this application draws the window buttons itself."
                  : "Room was reserved on the leading edge, so those are the system's own traffic lights up there."}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Layers className="size-4" aria-hidden="true" />
                This window
              </CardTitle>
              <CardDescription>Asked of the runtime once the page was running.</CardDescription>
            </CardHeader>
            <CardContent>
              {facts ? (
                <dl className="grid grid-cols-[max-content_1fr] gap-x-5 gap-y-1.5 text-sm">
                  <Row term="Application" value={facts.application} />
                  <Row term="Label" value={facts.label} />
                  <Row term="Title" value={facts.title} />
                  <Row term="Windows open" value={facts.windows} />
                </dl>
              ) : (
                <p className="text-muted-foreground text-sm">Asking...</p>
              )}
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <MoveDiagonal className="size-4" aria-hidden="true" />
              Try the bar
            </CardTitle>
            <CardDescription>
              Drag the window by any empty part of the title bar. The runtime moves it from the
              band the hidden bar left behind, and skips the controls inside it - so the buttons
              up there still click.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => void appWindow.center()}>
              Centre
            </Button>
            <Button variant="outline" size="sm" onClick={() => void appWindow.toggleMaximize()}>
              Toggle maximise
            </Button>
            <Button variant="outline" size="sm" onClick={() => void appWindow.minimize()}>
              Minimise
            </Button>
            <Badge variant="outline" className="ml-auto">
              shadcn/ui, Tailwind v4
            </Badge>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}

function Row({ term, value }: { term: string; value: string }) {
  return (
    <>
      <dt className="text-muted-foreground">{term}</dt>
      <dd className="m-0 font-medium">{value}</dd>
    </>
  );
}
