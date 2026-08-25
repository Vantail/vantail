/** Turning a project name into the identifiers a template needs. */

/** `My Notes` becomes `com.example.mynotes` - a starting point, not a decree. */
export function suggestIdentifier(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 32);
  return `com.example.${slug || "app"}`;
}

/** A name npm will accept in `package.json`. */
export function toPackageName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "vantail-app";
}
