// Pure file-name sanitizers shared by the project-file actions. Kept in their
// own module (free of React/store/plugin imports) so they can be unit-tested in
// Node without pulling in the whole hook graph.

import { DEFAULT_PROJECT_NAME } from "@geolibre/core";

export const PROJECT_FILE_SUFFIX = ".geoim3d.json";
export const PROJECT_FILE_DIALOG_EXTENSION = "geoim3d.json";

const LEGACY_PROJECT_SUFFIXES = [".geolibre.json", ".geolibre"] as const;

function leafFileName(path: string): string {
  return path.split(/[/\\]/).pop() ?? "";
}

/** Whether a path or file name uses the one canonical geoIM3D project suffix. */
export function isCanonicalProjectFileName(path: string): boolean {
  return leafFileName(path).toLowerCase().endsWith(PROJECT_FILE_SUFFIX);
}

/** Whether a local path or HTTP(S) URL uses the canonical project suffix. */
export function isCanonicalProjectReference(value: string): boolean {
  if (/^https?:\/\//i.test(value)) {
    try {
      return isCanonicalProjectFileName(new URL(value).pathname);
    } catch {
      return false;
    }
  }
  return isCanonicalProjectFileName(value);
}

/** Whether a path still uses an upstream project suffix that is not imported. */
export function isLegacyProjectFileName(path: string): boolean {
  const lower = leafFileName(path).toLowerCase();
  return LEGACY_PROJECT_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

/**
 * Ensure every newly written project uses the canonical geoIM3D extension.
 * Legacy project and generic JSON suffixes are replaced, never preserved.
 *
 * @param name - The raw file name or local path.
 * @returns A trimmed name/path ending in `.geoim3d.json`.
 */
export function ensureProjectFileName(name: string): string {
  const trimmed = name.trim() || DEFAULT_PROJECT_NAME;
  if (isCanonicalProjectFileName(trimmed)) return trimmed;

  const withoutOldSuffix = trimmed.replace(
    /(?:\.geolibre\.json|\.geolibre|\.json)$/i,
    "",
  );
  const base = withoutOldSuffix.trim() || DEFAULT_PROJECT_NAME;
  return `${base}${PROJECT_FILE_SUFFIX}`;
}

/**
 * Ensure an exported HTML file name carries an `.html`/`.htm` extension,
 * defaulting to a slug-based name when blank so the browser download opens as a
 * web page rather than an unknown file type.
 *
 * @param name - The raw file name the user typed.
 * @param fallbackSlug - The project-derived slug used when the name is blank.
 * @returns A sanitized file name ending in `.html` (or the user's `.htm`).
 */
export function ensureHtmlFileName(name: string, fallbackSlug: string): string {
  const trimmed = name.trim();
  // A blank name, or one that is only dots (which would otherwise yield e.g.
  // "..html"), has no usable base, so fall back to the slug-derived name.
  if (!trimmed || /^\.+$/.test(trimmed)) return `${fallbackSlug}.html`;
  return /\.html?$/i.test(trimmed) ? trimmed : `${trimmed}.html`;
}
