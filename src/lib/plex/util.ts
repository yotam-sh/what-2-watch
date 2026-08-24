// ---------------------------------------------------------------------------
// Defensive coercion helpers shared across the Plex modules.
//
// Constraint 8 from the master plan: PMS's JSON responses (even with
// `Accept: application/json`) sometimes give numeric attributes as strings,
// and omit empty collections entirely rather than returning `[]`/`{}`. Every
// place that reads a Plex attribute or a Plex child-element collection must
// go through these rather than assuming the "obvious" JS type.
// ---------------------------------------------------------------------------

/** Coerces a value that should be numeric but may arrive as a number, a
 *  numeric string, or be missing/blank/garbage. Returns `undefined` rather
 *  than `NaN` for anything that doesn't parse, so callers can use `??`. */
export function coerceNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** Same as coerceNumber but rounds to an integer — Plex's rating keys,
 *  counts, and timestamps are all logically integers even when the wire
 *  representation is a float-looking string. */
export function coerceInt(value: unknown): number | undefined {
  const n = coerceNumber(value);
  return n === undefined ? undefined : Math.trunc(n);
}

export function coerceString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return undefined;
}

/** Coerces a Plex child-element collection to an array. Handles the three
 *  shapes constraint 8 warns about:
 *    - missing/undefined/null key entirely (empty collection omitted, not `[]`)
 *    - a single object instead of a one-element array (both JSON responses
 *      and fast-xml-parser's XML->object conversion do this when there's
 *      exactly one child)
 *    - an actual array (the "normal" case)
 */
export function coerceArray<T>(value: T[] | T | null | undefined): T[] {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/** Coerces a boolean-ish Plex attribute ("1"/"0", 1/0, true/false) to a real
 *  boolean, defaulting to `false` for anything absent or unrecognized. */
export function coerceBool(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value === "1" || value.toLowerCase() === "true";
  return false;
}
