import { useState } from "react";

const COLLAPSE_THRESHOLD = 900;

export function ThoughtBlock({ thought }: { thought: string }) {
  const [expanded, setExpanded] = useState(false);
  if (!thought) return null;

  const long = thought.length > COLLAPSE_THRESHOLD;
  const shown = long && !expanded ? thought.slice(0, COLLAPSE_THRESHOLD) + "…" : thought;

  return (
    <div className="thought">
      <div className="thought-label">Thought</div>
      <pre className="thought-pre">{shown}</pre>
      {long && (
        <button className="ghost-btn" onClick={() => setExpanded((v) => !v)}>
          {expanded ? "收起" : "展开完整思考"}
        </button>
      )}
    </div>
  );
}
