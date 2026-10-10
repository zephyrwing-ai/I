/** Stable JSON text uses the same omission and array semantics as persisted JSON. */
export function canonicalJson(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError("Value must be JSON serializable.");
  return encodeCanonical(JSON.parse(serialized) as unknown);
}

function encodeCanonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(encodeCanonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${encodeCanonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function jsonEqual(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}
