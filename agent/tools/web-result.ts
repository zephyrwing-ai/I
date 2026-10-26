export interface WebPage {
  url: string;
  title: string;
  snippet?: string;
  faviconUrl?: string;
}

export interface WebToolMetadata {
  pages: WebPage[];
}

/** Shared by stored outcomes and the renderer; credentials and active URL schemes stay out of links. */
export function normalizeWebUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 8_192 || /[\u0000-\u0020\u007f]/.test(value)) return undefined;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

export function readWebToolMetadata(value: unknown): WebToolMetadata | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const metadata = value as Record<string, unknown>;
  if (!Array.isArray(metadata.pages) || metadata.pages.length > 20) return undefined;
  const pages: WebPage[] = [];
  for (const entry of metadata.pages) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
    const page = entry as Record<string, unknown>;
    const url = normalizeWebUrl(page.url);
    if (!url || typeof page.title !== "string" || !page.title.trim() || page.title.length > 2_048) return undefined;
    if (page.snippet !== undefined && (typeof page.snippet !== "string" || page.snippet.length > 16_384)) return undefined;
    const faviconUrl = page.faviconUrl === undefined ? undefined : normalizeWebUrl(page.faviconUrl);
    if (page.faviconUrl !== undefined && !faviconUrl) return undefined;
    pages.push({
      url, title: page.title,
      ...(page.snippet === undefined ? {} : { snippet: page.snippet as string }),
      ...(faviconUrl === undefined ? {} : { faviconUrl }),
    });
  }
  return { pages };
}
