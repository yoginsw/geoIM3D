function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Remove portable project environment values before relay storage or broadcast.
 * The worker otherwise treats project JSON as opaque and preserves every field.
 */
export function sanitizePortableProjectSnapshot(snapshot: unknown): unknown {
  if (!isRecord(snapshot) || !isRecord(snapshot.preferences)) return snapshot;

  return {
    ...snapshot,
    preferences: {
      ...snapshot.preferences,
      environmentVariables: [],
    },
  };
}
