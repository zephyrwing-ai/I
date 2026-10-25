import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import type { AttachmentStore } from "./store.js";

/** Opaque local media URLs, including range requests for native video controls. */
export async function attachmentResourceResponse(store: AttachmentStore, request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.protocol !== "attachment:" || !/^[a-f0-9]{64}$/.test(url.hostname)
    || !["/preview", "/original"].includes(url.pathname) || url.search || url.hash
    || !["GET", "HEAD"].includes(request.method)) return new Response(null, { status: 404 });
  try {
    const resource = await store.resource(url.hostname, url.pathname.slice(1));
    const size = (await stat(resource.path)).size;
    const headers = new Headers({ "Content-Type": resource.mediaType, "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff" });
    let start = 0;
    let end = size - 1;
    let status = 200;
    const range = request.headers.get("range");
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match || (!match[1] && !match[2])) return invalidRange(size);
      start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
      end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= size) return invalidRange(size);
      headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
      status = 206;
    }
    headers.set("Content-Length", String(Math.max(0, end - start + 1)));
    const stream = request.method === "HEAD" || size === 0 ? null : Readable.toWeb(createReadStream(resource.path, { start, end }));
    return new Response(stream as ReadableStream<Uint8Array> | null, { status, headers });
  } catch {
    return new Response(null, { status: 404 });
  }
}

function invalidRange(size: number): Response {
  return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
}
