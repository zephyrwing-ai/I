import { useEffect, useReducer, useRef, useState } from "react";
import { StatusBar } from "./components/StatusBar";
import { StepCard } from "./components/StepCard";
import { Toolbar } from "./components/Toolbar";
import { ConfigPanel } from "./components/ConfigPanel";
import { agentReducer, initialAgentState } from "./store/agentReducer";
import { DEFAULT_SETTINGS, type RunSettings } from "./store/runSettings";
import type { RunRequest } from "../../shell/shared/ipc";

export default function App() {
  const [state, dispatch] = useReducer(agentReducer, initialAgentState);
  const [settings, setSettings] = useState<RunSettings>(DEFAULT_SETTINGS);
  const [configOpen, setConfigOpen] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const running = state.status === "running";

  useEffect(() => {
    const offEvent = window.agentAPI.onEvent((e) => {
      dispatch({ type: "event", event: e });
      if (e.type === "done") setError(null);
    });
    return offEvent;
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [state.steps.length, state.steps[state.steps.length - 1]?.actions.length]);

  const handleRun = async (req: RunRequest): Promise<void> => {
    setError(null);
    dispatch({ type: "reset" });
    const ack = await window.agentAPI.run(req);
    if (!ack.ok) {
      setError(ack.error);
      dispatch({ type: "event", event: { type: "done", status: "error", totalSteps: 0 } });
    }
  };

  const handleStop = (): void => window.agentAPI.stop();

  return (
    <div className="app">
      <Toolbar
        running={running}
        settings={settings}
        configOpen={configOpen}
        onRun={handleRun}
        onStop={handleStop}
        onToggleConfig={() => setConfigOpen((v) => !v)}
      />

      <div className="workspace">
        <main className="transcript">
          {error && <div className="error-banner">{error}</div>}
          {state.steps.length === 0 && state.status === "idle" && (
            <div className="empty">选择一个工作目录，输入任务，然后点击「运行」。</div>
          )}
          {state.steps.map((s) => (
            <StepCard key={s.stepNumber} step={s} />
          ))}
          <div ref={bottomRef} />
        </main>

        {configOpen && <ConfigPanel settings={settings} onChange={setSettings} disabled={running} />}
      </div>

      <StatusBar status={state.status} totalSteps={state.totalSteps} />
    </div>
  );
}
