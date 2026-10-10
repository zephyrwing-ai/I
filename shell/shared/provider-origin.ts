/** Saved credentials may be reused only for the same HTTP(S) origin. */
export function haveSameProviderOrigin(left: string, right: string): boolean {
  const leftOrigin = providerOrigin(left);
  return leftOrigin !== null && leftOrigin === providerOrigin(right);
}

function providerOrigin(baseURL: string): string | null {
  try {
    const url = new URL(baseURL.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}
