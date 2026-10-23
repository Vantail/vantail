/**
 * The Node release lines this CLI supports, and the first patch on each that
 * carries the Brotli decoder fix.
 *
 * CVE-2026-111497 is an out-of-bounds write in the Brotli decoder bundled
 * with Node. Node 22.23.4, 24.22.1 and 26.12.1 are the October 2026 releases
 * that fix it. Node 20 is end-of-life and never receives the patch, so it is
 * no longer a supported line.
 *
 * Keep this in step with the `engines` fields in the package manifests.
 */
const MINIMUM: Record<number, readonly [number, number, number]> = {
  22: [22, 23, 4],
  24: [24, 22, 1],
  26: [26, 12, 1],
};

/** The supported versions, as a sentence a failed check can print. */
export const NODE_REQUIREMENT = "Node 22.23.4+, 24.22.1+ or 26.12.1+";

/** Whether `version` is a Node release this CLI is willing to run on. */
export function supportedNode(version: string): boolean {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);

  const minimum = MINIMUM[major];
  // The engine range is open above 26, so a future line is allowed.
  if (minimum === undefined) return major > 26;

  const [, minimumMinor, minimumPatch] = minimum;
  return (
    minor > minimumMinor ||
    (minor === minimumMinor && patch >= minimumPatch)
  );
}
