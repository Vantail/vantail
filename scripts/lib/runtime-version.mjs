/**
 * Which published runtime version a release can reuse.
 *
 * A release that changes no Rust reuses the last release's binaries rather
 * than rebuilding five of them, so it has to name a version. That name ends up
 * as the version every platform package is depended on at, which makes this a
 * short piece of code with a long blast radius: get it wrong and no binary
 * resolves for anybody.
 *
 * It is derived from the platform packages themselves rather than from
 * `@vantail/runtime`'s `optionalDependencies`. That field was the obvious
 * source and it was the wrong one twice over: it can be read back in a shape
 * that turns into `[object Object]`, and it names whatever the last release
 * *claimed* rather than what is actually installable.
 */

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

/** Newest first, with a release ahead of its own prereleases. */
export function compareVersions(a, b) {
  const parts = (v) => {
    const [core, pre] = v.split(/[-+]/, 2);
    return { nums: core.split(".").map(Number), pre };
  };
  const left = parts(a);
  const right = parts(b);

  for (let i = 0; i < 3; i += 1) {
    const diff = (right.nums[i] ?? 0) - (left.nums[i] ?? 0);
    if (diff !== 0) return diff;
  }
  // `1.0.0` outranks `1.0.0-dev.3`, which is what "reuse the last release"
  // means when a dev build published a prerelease of the same number.
  if (!left.pre && right.pre) return -1;
  if (left.pre && !right.pre) return 1;
  return (right.pre ?? "").localeCompare(left.pre ?? "");
}

/**
 * The newest version every one of these packages actually has.
 *
 * Every one, not the newest anybody has: the reusing release declares all of
 * them at a single version, so a version one package is missing would make the
 * whole install fail. A variant added since the last release is missing from
 * all of them, which is exactly the case that has to come back empty rather
 * than pick something that half-works.
 *
 * @param {Record<string, string[]>} published package name -> versions it has
 * @returns {string | undefined}
 */
export function newestCommonVersion(published) {
  const lists = Object.values(published);
  if (lists.length === 0) return undefined;

  const [first, ...rest] = lists;
  const shared = first
    .filter(isVersion)
    .filter((version) => rest.every((list) => list.includes(version)));

  return shared.sort(compareVersions)[0];
}

/** Which of these packages the registry has never heard of. */
export function neverPublished(published) {
  return Object.entries(published)
    .filter(([, versions]) => versions.length === 0)
    .map(([name]) => name);
}
