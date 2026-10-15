/** Unambiguous UTC timestamp for evidence and record identity lines. */
export function formatTime(ms: number): string {
  if (!Number.isFinite(ms)) return "unknown time";
  return new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

/** First present string field, for row titles. */
export function firstText(body: Record<string, unknown> | null, names: readonly string[]): string | null {
  if (!body) return null;
  for (const name of names) {
    const value = body[name];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}
