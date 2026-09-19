import { useEffect, useRef, type KeyboardEvent, type RefObject } from "react";
import { Icon } from "./Icon";
import type { SearchResult } from "../store/search";

interface TopBarProps {
  outputOpen: boolean;
  outputCount: number;
  canvasOpen?: boolean;
  searchOpen: boolean;
  settingsOpen: boolean;
  searchButtonRef: RefObject<HTMLButtonElement>;
  settingsButtonRef: RefObject<HTMLButtonElement>;
  onOutput: () => void;
  onCanvas?: () => void;
  onSearch: () => void;
  onSettings: () => void;
}

export function TopBar({ outputOpen, outputCount, canvasOpen = false, searchOpen, settingsOpen, searchButtonRef, settingsButtonRef, onOutput, onCanvas = () => undefined, onSearch, onSettings }: TopBarProps) {
  return (
    <header className="topbar">
      <h1 className="sr-only">Agent Workbench</h1>
      <div className="topbar-actions">
        <button className={`icon-button ${outputOpen ? "active" : ""}`} onClick={onOutput} title={outputOpen ? "Hide output files" : "Show output files"} aria-label={outputOpen ? "Hide output files" : "Show output files"} aria-expanded={outputOpen} aria-controls="right-sidebar">
          <Icon name={outputOpen ? "sidebar" : "sidebar-collapsed"} width="18" height="18" strokeWidth={2} />
          {!outputOpen && !canvasOpen && outputCount > 0 && <span className="icon-badge">{outputCount > 9 ? "9+" : outputCount}</span>}
        </button>
        <button className={`icon-button ${canvasOpen ? "active" : ""}`} onClick={onCanvas} title={canvasOpen ? "Hide canvas" : "Show canvas"} aria-label={canvasOpen ? "Hide canvas" : "Show canvas"} aria-expanded={canvasOpen} aria-controls="right-sidebar">
          <Icon name="line-squiggle" width="18" height="18" strokeWidth={2} />
        </button>
        <button ref={searchButtonRef} className={`icon-button ${searchOpen ? "active" : ""}`} onClick={onSearch} title="Search all content" aria-label="Search all content" aria-expanded={searchOpen} aria-controls="search-popover">
          <Icon name="search" width="18" height="18" strokeWidth={2} />
        </button>
        <button ref={settingsButtonRef} className={`icon-button ${settingsOpen ? "active" : ""}`} onClick={onSettings} title="Settings" aria-label="Settings" aria-expanded={settingsOpen}>
          <Icon name="settings" width="18" height="18" strokeWidth={2} />
        </button>
      </div>
    </header>
  );
}

interface SearchPopoverProps {
  query: string;
  onQueryChange: (query: string) => void;
  results: SearchResult[];
  activeBlockId: string | null;
  loadingHistory: boolean;
  hydrated: boolean;
  hasMoreHistory: boolean;
  error: string | null;
  panelRef: RefObject<HTMLDivElement>;
  onSelect: (result: SearchResult) => void;
  onRetry: () => void;
}

function HighlightedSnippet({ result }: { result: SearchResult }) {
  const { start, end } = result.snippetMatchRange;
  return (
    <>
      {result.snippet.slice(0, start)}
      <mark>{result.snippet.slice(start, end)}</mark>
      {result.snippet.slice(end)}
    </>
  );
}

export function SearchPopover({
  query,
  onQueryChange,
  results,
  activeBlockId,
  loadingHistory,
  hydrated,
  hasMoreHistory,
  error,
  panelRef,
  onSelect,
  onRetry,
}: SearchPopoverProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);

  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (!results.length) return;
    const currentIndex = results.findIndex((result) => result.blockId === activeBlockId);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      onSelect(results[(currentIndex + 1 + results.length) % results.length]!);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      onSelect(results[(currentIndex - 1 + results.length) % results.length]!);
    } else if (event.key === "Enter" && currentIndex >= 0) {
      event.preventDefault();
      onSelect(results[currentIndex]!);
    }
  };

  const queryActive = query.trim().length > 0;
  const activeIndex = results.findIndex((result) => result.blockId === activeBlockId);
  const activeOptionId = activeIndex >= 0 ? `search-result-${activeIndex}` : undefined;

  return (
    <div className="search-layer">
      <div className="search-backdrop" aria-hidden="true" />
      <div id="search-popover" ref={panelRef} className="search-popover" role="dialog" aria-label="Search all content">
        <span className="search-glyph"><Icon name="search" width="18" height="18" strokeWidth={2} /></span>
        <input
          ref={inputRef}
          type="search"
          role="searchbox"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={onInputKeyDown}
          placeholder="Search..."
          aria-label="Search content"
          aria-controls="search-results"
          aria-activedescendant={activeOptionId}
        />
        {queryActive && (
          <div className="search-results" id="search-results" role="listbox" aria-label="Search results">
            {!hydrated && <div className="search-status">Loading messages…</div>}
            {hydrated && results.map((result, index) => (
              <button
                key={result.blockId}
                id={`search-result-${index}`}
              type="button"
              role="option"
              aria-selected={result.blockId === activeBlockId}
              className="search-result"
              onClick={() => onSelect(result)}
              >
                <span className="search-result-marker" aria-hidden="true" />
                <span className="search-result-text"><HighlightedSnippet result={result} /></span>
              </button>
            ))}
            {hydrated && results.length === 0 && !loadingHistory && !hasMoreHistory && !error && (
              <div className="search-status">No matching messages found</div>
            )}
            {hydrated && loadingHistory && <div className="search-status">Searching earlier messages…</div>}
            {hydrated && hasMoreHistory && !loadingHistory && !results.length && <div className="search-status">Preparing more messages…</div>}
            {error && (
              <div className="search-status search-status-error" role="alert">
                <span>{error}</span>
                <button type="button" onClick={onRetry}>Retry</button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
