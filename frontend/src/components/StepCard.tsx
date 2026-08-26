import type { Step } from "../store/agentReducer";
import { OutputBlock } from "./OutputBlock";
import { ThoughtBlock } from "./ThoughtBlock";

export function StepCard({ step }: { step: Step }) {
  return (
    <article className="step-card">
      <header className="step-header">
        <span className="step-num">Step {step.stepNumber}</span>
        <span className="step-count">{step.messageCount} messages</span>
      </header>
      <ThoughtBlock thought={step.thought} />
      {step.actions.length > 0 && (
        <div className="actions">
          {step.actions.map((action, i) => (
            <div className="action-row" key={i}>
              <div className="action-command">
                <span className="prompt-symbol">$</span> {action.command}
              </div>
              <OutputBlock action={action} />
            </div>
          ))}
        </div>
      )}
    </article>
  );
}
