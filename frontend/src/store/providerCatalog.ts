import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ModelOption, ProviderProfileSummary } from "../../../shell/shared/ipc";

interface ProviderCatalogState {
  profiles: ProviderProfileSummary[];
  modelOptions: ModelOption[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useProviderCatalog(): ProviderCatalogState {
  const [profiles, setProfiles] = useState<ProviderProfileSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

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
    () => profiles.flatMap((profile) => profile.models),
    [profiles],
  );

  return { profiles, modelOptions, loading, error, refresh };
}
