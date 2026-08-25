/**
 * The one place that talks to the runtime.
 *
 * Requests go out through the injected bridge and come back matched by id.
 * Everything else in this package is a typed wrapper around `invoke`.
 */

import {
  isEventMessage,
  type VantailBridge,
  type VantailIncoming,
} from "./protocol.js";

import { noRuntime, VantailError } from "./error.js";

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

const pending = new Map<string, Pending>();
const listeners = new Map<string, Set<(payload: never) => void>>();

let subscription: (() => void) | null = null;
let counter = 0;

function getBridge(): VantailBridge | undefined {
  return (globalThis as { __VANTAIL__?: VantailBridge }).__VANTAIL__;
}

/** Whether this page is running inside a Vantail window. */
export function isVantail(): boolean {
  return getBridge() !== undefined;
}

/**
 * Static application facts the runtime injected, available synchronously.
 * Returns `undefined` in a plain browser.
 */
export function bridgeInfo(): VantailBridge["app"] | undefined {
  return getBridge()?.app;
}

/** Version of the native runtime, or `undefined` outside one. */
export function runtimeVersion(): string | undefined {
  return getBridge()?.version;
}

/**
 * The label of the window this code is running in, without awaiting.
 * `undefined` in a plain browser.
 */
export function windowLabel(): string | undefined {
  return getBridge()?.label;
}

function requireBridge(): VantailBridge {
  const bridge = getBridge();
  if (!bridge) throw noRuntime();
  subscribe(bridge);
  return bridge;
}

function subscribe(bridge: VantailBridge): void {
  if (subscription) return;
  subscription = bridge.subscribe(receive);
}

function receive(message: VantailIncoming): void {
  if (isEventMessage(message)) {
    const handlers = listeners.get(message.event);
    if (!handlers) return;
    // Copy first: a handler is allowed to unsubscribe itself.
    for (const handler of [...handlers]) {
      try {
        (handler as (payload: unknown) => void)(message.payload);
      } catch (error) {
        console.error(`[vantail] a "${message.event}" listener threw`, error);
      }
    }
    return;
  }

  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);

  if (message.error) {
    entry.reject(VantailError.from(message.error));
  } else {
    entry.resolve(message.result ?? null);
  }
}

/**
 * Call a native method.
 *
 * Prefer the typed modules (`filesystem`, `dialog`, ...); this is the escape
 * hatch for methods the SDK does not wrap yet.
 */
export function invoke<T = unknown>(
  method: string,
  params?: unknown,
): Promise<T> {
  let bridge: VantailBridge;
  try {
    bridge = requireBridge();
  } catch (error) {
    return Promise.reject(error);
  }

  const id = nextId();

  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    try {
      bridge.postMessage({ id, method, params });
    } catch (error) {
      pending.delete(id);
      reject(
        new VantailError(
          "INTERNAL",
          `Could not send \`${method}\` to the runtime: ${String(error)}`,
        ),
      );
    }
  });
}

/**
 * Listen for a runtime event. Returns an unsubscribe function.
 *
 * Listening does not require the runtime to be present - outside a Vantail
 * window the returned function is simply never called.
 */
export function listen<T = unknown>(
  event: string,
  handler: (payload: T) => void,
): () => void {
  let handlers = listeners.get(event);
  if (!handlers) {
    handlers = new Set();
    listeners.set(event, handlers);
  }
  handlers.add(handler as (payload: never) => void);

  // Registered before subscribing: subscribing hands over anything that
  // arrived before this page's script ran, and a handler added afterwards
  // would miss exactly the message it was written for.
  const bridge = getBridge();
  if (bridge) subscribe(bridge);

  return () => {
    const current = listeners.get(event);
    if (!current) return;
    current.delete(handler as (payload: never) => void);
    if (current.size === 0) listeners.delete(event);
  };
}

function nextId(): string {
  const crypto = globalThis.crypto;
  if (crypto && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Only needs to be unique within this page, not unguessable: the channel is
  // the platform's own IPC, not a network socket.
  counter += 1;
  return `vantail-${Date.now().toString(36)}-${counter}`;
}
