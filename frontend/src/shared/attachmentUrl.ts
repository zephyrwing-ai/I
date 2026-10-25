/** Accept only URLs supplied by the attachment host. */
export function safeAttachmentUrl(value: string | undefined): string | undefined {
  if (!value || /[\s\u0000-\u001f\u007f]/.test(value)) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol === "blob:" || (url.protocol === "attachment:" && url.hostname && !url.username && !url.password)) return value;
  } catch {
    // Invalid media references render the fixed-size fallback.
  }
  return undefined;
}
