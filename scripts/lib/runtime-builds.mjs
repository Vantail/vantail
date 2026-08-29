/**
 * Every runtime package a release publishes.
 *
 * A build is a Rust target crossed with a variant: `default` is what nearly
 * every application uses, and `sqlcipher` adds database encryption along with
 * about 3 MB of crypto, which is why it is a separate package rather than
 * something everybody carries.
 *
 * This lives on its own because both the packaging script and the publish
 * script need the list, and when they each worked it out for themselves the
 * publish one kept only the plain names - so the encrypted packages would have
 * been built, never declared, and never installed by anyone.
 */

/**
 * @param {{ targets: object[], variants: { id: string, suffix: string }[] }} platforms
 * @returns {object[]} one entry per package, with `package` and `dir` resolved
 */
export function runtimeBuilds(platforms) {
  return platforms.targets.flatMap((target) =>
    platforms.variants.map((variant) => ({
      ...target,
      variant,
      package: `${target.package}${variant.suffix}`,
      // The default variant keeps the bare target name, so an artifact layout
      // that predates variants still lines up.
      dir: `${target.rust}${variant.suffix}`,
    })),
  );
}
