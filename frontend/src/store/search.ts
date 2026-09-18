import type { AgentState } from "./agentReducer";
import { buildMessageBlockRecords } from "./messageBlocks";

export interface SearchMessageBlock {
  blockId: string;
  text: string;
}

export interface SearchMatchRange {
  /** UTF-16 offsets in the source message text. */
  start: number;
  end: number;
}

export interface SearchResult extends SearchMessageBlock {
  /** A short, first-match-centred representation for the result list. */
  snippet: string;
  /** The first match in `text`; the same match is represented in `snippetMatchRange`. */
  matchRange: SearchMatchRange;
  /** UTF-16 offsets in `snippet`, including any leading ellipsis. */
  snippetMatchRange: SearchMatchRange;
}

export interface SearchOptions {
  /** Number of source-text characters kept on each side of the first match. */
  contextChars?: number;
}

const DEFAULT_CONTEXT_CHARS = 48;

/**
 * Derives the searchable message-block sequence from the loaded AgentState.
 * The sequence mirrors the user-message and final-answer blocks in MessageStream.
 */
export function buildSearchIndex(
  state: Pick<AgentState, "runOrder" | "runs">,
): SearchMessageBlock[] {
  return buildMessageBlockRecords(state)
    .filter((block): block is typeof block & { text: string } => (
      (block.kind === "user" || block.kind === "assistant") && typeof block.text === "string" && block.text.length > 0
    ))
    .map(({ blockId, text }) => ({ blockId, text }));
}

function foldWithBoundaries(text: string): { value: string; boundaries: number[] } {
  let value = "";
  const boundaries = [0];

  for (let sourceOffset = 0; sourceOffset < text.length;) {
    const codePoint = text.codePointAt(sourceOffset);
    if (codePoint === undefined) break;
    const sourceChar = String.fromCodePoint(codePoint);
    const foldedChar = sourceChar.toLowerCase();
    value += foldedChar;
    for (let foldedOffset = 0; foldedOffset < foldedChar.length; foldedOffset += 1) {
      boundaries.push(
        foldedOffset === foldedChar.length - 1
          ? sourceOffset + sourceChar.length
          : sourceOffset,
      );
    }
    sourceOffset += sourceChar.length;
  }

  return { value, boundaries };
}

function firstMatch(text: string, query: string): SearchMatchRange | null {
  const foldedText = foldWithBoundaries(text);
  const foldedQuery = query.toLowerCase();
  const start = foldedText.value.indexOf(foldedQuery);
  if (start < 0) return null;

  const end = start + foldedQuery.length;
  return {
    start: foldedText.boundaries[start] ?? start,
    end: foldedText.boundaries[end] ?? end,
  };
}

function makeSnippet(
  text: string,
  matchRange: SearchMatchRange,
  contextChars: number,
): Pick<SearchResult, "snippet" | "snippetMatchRange"> {
  const start = Math.max(0, matchRange.start - contextChars);
  const end = Math.min(text.length, matchRange.end + contextChars);
  const leadingEllipsis = start > 0 ? "…" : "";
  const trailingEllipsis = end < text.length ? "…" : "";
  const snippet = `${leadingEllipsis}${text.slice(start, end)}${trailingEllipsis}`;
  const matchStart = leadingEllipsis.length + matchRange.start - start;

  return {
    snippet,
    snippetMatchRange: { start: matchStart, end: matchStart + (matchRange.end - matchRange.start) },
  };
}

/**
 * Searches each message block once using a case-insensitive substring match.
 * Results keep the first match, even when a block contains the query repeatedly.
 */
export function searchMessageBlocks(
  blocks: readonly SearchMessageBlock[],
  query: string,
  options: SearchOptions = {},
): SearchResult[] {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) return [];

  const contextChars = Math.max(0, Math.floor(options.contextChars ?? DEFAULT_CONTEXT_CHARS));
  const results: SearchResult[] = [];

  for (const block of blocks) {
    const matchRange = firstMatch(block.text, normalizedQuery);
    if (!matchRange) continue;
    results.push({
      ...block,
      ...makeSnippet(block.text, matchRange, contextChars),
      matchRange,
    });
  }

  return results;
}
