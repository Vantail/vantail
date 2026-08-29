/**
 * Reading the runtime version out of what the registry says.
 *
 * A release that changes no Rust reuses the last release's binaries, so it has
 * to ask the registry which version those were. That answer ends up as the
 * version every platform package is depended on at, which makes this a short
 * piece of code with a long blast radius: get it wrong and no binary resolves
 * for anybody.
 */

/**
 * The versions named by an `npm view ... optionalDependencies --json` answer.
 *
 * npm replies in one of two shapes. Normally it is the field itself:
 *
 *   { "@vantail/runtime-darwin-arm64": "0.1.5", ... }
 *
 * When the spec matches more than one version - which happens when the
 * dist-tag is missing - it is keyed by version instead, and each value is the
 * whole field object:
 *
 *   { "0.1.5": { "@vantail/runtime-darwin-arm64": "0.1.5", ... }, ... }
 *
 * Both shapes used to go through `String()`, and the second turned every entry
 * into the literal `[object Object]`. That was published as the version to
 * depend on, so nothing could resolve - and every later release read it back
 * and passed it on.
 */
export function versionsFrom(parsed) {
  const values = Object.values(parsed ?? {});
  const nested = values.filter(
    (value) => value !== null && typeof value === "object",
  );
  const flattened = nested.length > 0 ? nested.flatMap(Object.values) : values;
  return [...new Set(flattened)];
}

/**
 * A version, and nothing that merely survives being turned into a string.
 *
 * Deliberately strict: this value is written into a published manifest, where
 * anything that is not a version is an install failure for every user.
 */
export function isVersion(value) {
  return (
    typeof value === "string" &&
    /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value)
  );
}
