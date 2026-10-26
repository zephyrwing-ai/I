import { useCallback, useRef, useState, useSyncExternalStore, type SetStateAction } from "react";

type DraftProjectId = string | null;

export interface ComposerDraftRestore {
  id: string;
  projectId: DraftProjectId;
  text: string;
}

interface DraftSubmission {
  readonly projectId: DraftProjectId;
  readonly text: string;
  readonly revision: number;
}

interface DraftState {
  readonly text: string;
  readonly revision: number;
  readonly submission: DraftSubmission | null;
}

interface DraftScope {
  readonly projectId: DraftProjectId;
}

/** One Composer owns the text drafts for its window; asynchronous actions retain their source. */
class ComposerDrafts {
  private readonly drafts = new Map<DraftProjectId, DraftState>();
  private readonly restoredInputs = new Set<string>();
  private readonly listeners = new Set<() => void>();

  read = (projectId: DraftProjectId): DraftState => {
    let draft = this.drafts.get(projectId);
    if (!draft) {
      draft = { text: "", revision: 0, submission: null };
      this.drafts.set(projectId, draft);
    }
    return draft;
  };

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  setText(projectId: DraftProjectId, next: SetStateAction<string>): void {
    const draft = this.read(projectId);
    const text = typeof next === "function" ? next(draft.text) : next;
    if (text === draft.text) return;
    this.publish(projectId, { ...draft, text, revision: draft.revision + 1 });
  }

  beginSubmission(projectId: DraftProjectId): DraftSubmission | null {
    const draft = this.read(projectId);
    if (draft.submission) return null;
    const submission = { projectId, text: draft.text, revision: draft.revision };
    this.publish(projectId, { ...draft, submission });
    return submission;
  }

  finishSubmission = (submission: DraftSubmission, accepted: boolean): void => {
    const draft = this.read(submission.projectId);
    if (draft.submission !== submission) return;
    const consumed = accepted && draft.revision === submission.revision;
    this.publish(submission.projectId, {
      text: consumed ? "" : draft.text,
      revision: draft.revision + (consumed ? 1 : 0),
      submission: null,
    });
  };

  restore = (input: ComposerDraftRestore): boolean => {
    if (this.restoredInputs.has(input.id)) return false;
    this.restoredInputs.add(input.id);
    if (!input.text) return false;
    this.setText(input.projectId, (text) => text ? `${text}\n${input.text}` : input.text);
    return true;
  };

  private publish(projectId: DraftProjectId, draft: DraftState): void {
    this.drafts.set(projectId, draft);
    this.listeners.forEach((listener) => listener());
  }
}

export function useComposerDraft(projectId: DraftProjectId) {
  const [drafts] = useState(() => new ComposerDrafts());
  const read = useCallback(() => drafts.read(projectId), [drafts, projectId]);
  const draft = useSyncExternalStore(drafts.subscribe, read, read);
  const activeScope = useRef<DraftScope>({ projectId });
  if (activeScope.current.projectId !== projectId) activeScope.current = { projectId };
  const isCurrentScope = useCallback((scope: DraftScope) => activeScope.current === scope, []);
  const setText = useCallback((next: SetStateAction<string>) => drafts.setText(projectId, next), [drafts, projectId]);
  const beginSubmission = useCallback(() => drafts.beginSubmission(projectId), [drafts, projectId]);

  return {
    text: draft.text,
    submitting: draft.submission !== null,
    scope: activeScope.current,
    isCurrentScope,
    setText,
    beginSubmission,
    finishSubmission: drafts.finishSubmission,
    restore: drafts.restore,
  };
}
