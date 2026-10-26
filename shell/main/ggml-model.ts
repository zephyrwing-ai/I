import { open, stat } from "node:fs/promises";

const GGML_MAGIC = 0x67676d6c;
const GGML_HEADER_BYTES = 52;
const MEBIBYTE = 1024 * 1024;

const QUANTIZATION_NAMES: Record<number, string> = {
  0: "f32",
  1: "f16",
  2: "q4_0",
  3: "q4_1",
  6: "q5_0",
  7: "q5_1",
  8: "q8_0",
};

export interface GgmlModelInfo {
  family: string;
  quantization: string | null;
  multilingual: boolean;
  bytes: number;
}

export async function readGgmlModelInfo(filePath: string): Promise<GgmlModelInfo | null> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(filePath, "r");
    const header = Buffer.alloc(GGML_HEADER_BYTES);
    const { bytesRead } = await handle.read(header, 0, GGML_HEADER_BYTES, 0);
    if (bytesRead < GGML_HEADER_BYTES || header.readUInt32LE(0) !== GGML_MAGIC) return null;
    const vocabularySize = header.readInt32LE(8);
    const audioState = header.readInt32LE(16);
    const audioLayers = header.readInt32LE(24);
    const textLayers = header.readInt32LE(40);
    const ftype = header.readInt32LE(48);
    const fileStat = await stat(filePath);
    if (!fileStat.isFile() || fileStat.size < MEBIBYTE || fileStat.size > 8 * 1024 * MEBIBYTE) return null;
    return {
      family: familyFromLayers(audioState, audioLayers, textLayers),
      quantization: QUANTIZATION_NAMES[ftype] ?? null,
      multilingual: vocabularySize > 51864,
      bytes: fileStat.size,
    };
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function familyFromLayers(audioState: number, audioLayers: number, textLayers: number): string {
  if (audioState === 384 && audioLayers === 4) return "tiny";
  if (audioState === 512 && audioLayers === 6) return "base";
  if (audioState === 768 && audioLayers === 12) return "small";
  if (audioState === 1024 && audioLayers === 24) return "medium";
  if (audioState === 1280 && audioLayers === 32) return textLayers === 4 ? "large-v3-turbo" : "large";
  return "unknown";
}
