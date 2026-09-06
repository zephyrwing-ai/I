import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ModelOption, ProviderProfileSummary } from "../../../shell/shared/ipc";
import { restoreSelectedModelOption, retainSelectedModelOption } from "./providerSelection";

const MODEL_OPTION_KEY = "workbench.modelOptionId";

interface ProviderCatalogState {
  profiles: ProviderProfileSummary[];
  modelOptions: ModelOption[];
  selectedModelOptionId: string;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  selectModel: (modelOptionId: string) => void;
}

export function useProviderCatalog(): ProviderCatalogState {
  const [profiles, setProfiles] = useState<ProviderProfileSummary[]>([]);
  const [selectedModelOptionId, setSelectedModelOptionId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);
  const restoredSelection = useRef(false);

  const refresh = useCallback(async (): Promise<void> => {
    const currentRequest = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const nextProfiles = await window.agentAPI.listProviderProfiles();
      if (currentRequest === requestId.current) setProfiles(nextProfiles);
    } catch (cause) {
      if (currentRequest === requestId.current) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (currentRequest === requestId.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const modelOptions = useMemo(
    () => profiles.flatMap((profile) => profile.models.filter((model) => model.imported)),
    [profiles],
  );

  useEffect(() => {
    if (loading) return;
    setSelectedModelOptionId((current) => {
      const retained = retainSelectedModelOption(current, modelOptions);
      if (retained) return retained;
      if (!restoredSelection.current) {
        restoredSelection.current = true;
        const stored = localStorage.getItem(MODEL_OPTION_KEY) ?? "";
        const restored = restoreSelectedModelOption(stored, modelOptions);
        if (restored) return restored;
      }
      localStorage.removeItem(MODEL_OPTION_KEY);
      return "";
    });
  }, [loading, modelOptions]);

  const selectModel = useCallback((modelOptionId: string): void => {
    setSelectedModelOptionId(modelOptionId);
    if (modelOptionId) localStorage.setItem(MODEL_OPTION_KEY, modelOptionId);
    else localStorage.removeItem(MODEL_OPTION_KEY);
  }, []);

  return { profiles, modelOptions, selectedModelOptionId, loading, error, refresh, selectModel };
}
