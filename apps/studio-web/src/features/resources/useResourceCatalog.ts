import { useCallback, useEffect, useState } from "react";
import { fetchResourceCatalog, type ResourceCatalog } from "./api.js";

export function useResourceCatalog() {
  const [catalog, setCatalog] = useState<ResourceCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setCatalog(await fetchResourceCatalog());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "资源目录加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { catalog, loading, error, refresh };
}
