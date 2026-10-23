import { useCallback, useState } from "react";
import { errorMessage } from "@open-agent-tools/api-contracts/values";

/** Shared busy/error lifecycle for screen actions that expose one progress key. */
export function useAsyncAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback((key: string, task: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    void task()
      .catch((reason: unknown) => setError(errorMessage(reason)))
      .finally(() => setBusy(null));
  }, []);

  return { busy, error, setBusy, setError, run };
}
