import { useEffect, useRef, type RefObject } from "react";
import { Icon } from "./Icon";

interface TopBarProps {
  outputOpen: boolean;
  outputCount: number;
  searchOpen: boolean;
  settingsOpen: boolean;
  settingsButtonRef: RefObject<HTMLButtonElement>;
  onOutput: () => void;
  onSearch: () => void;
  onSettings: () => void;
}

export function TopBar({ outputOpen, outputCount, searchOpen, settingsOpen, settingsButtonRef, onOutput, onSearch, onSettings }: TopBarProps) {
  return (
    <header className="topbar">
      <h1 className="sr-only">主工作台</h1>
      <div className="topbar-actions">
        <button className={`icon-button ${outputOpen ? "active" : ""}`} onClick={onOutput} title={outputOpen ? "隐藏输出文件" : "显示输出文件"} aria-label={outputOpen ? "隐藏输出文件" : "显示输出文件"} aria-expanded={outputOpen} aria-controls="output-sidebar">
          <Icon name="sidebar" width="18" height="18" strokeWidth={2} />
          {!outputOpen && outputCount > 0 && <span className="icon-badge">{outputCount > 9 ? "9+" : outputCount}</span>}
        </button>
        <button className={`icon-button ${searchOpen ? "active" : ""}`} onClick={onSearch} title="搜索全局内容" aria-label="搜索全局内容">
          <Icon name="search" width="18" height="18" />
        </button>
        <button ref={settingsButtonRef} className={`icon-button ${settingsOpen ? "active" : ""}`} onClick={onSettings} title="设置" aria-label="设置" aria-expanded={settingsOpen}>
          <Icon name="settings" width="18" height="18" />
        </button>
      </div>
    </header>
  );
}

interface SearchPopoverProps {
  query: string;
  onQueryChange: (query: string) => void;
}

export function SearchPopover({ query, onQueryChange }: SearchPopoverProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);
  return (
    <div className="search-popover" role="dialog" aria-label="搜索全局内容">
      <div className="search-row">
        <span className="search-glyph"><Icon name="search" width="18" height="18" /></span>
        <input ref={inputRef} value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder="搜索任务、命令或输出…" aria-label="搜索内容" />
      </div>
    </div>
  );
}
