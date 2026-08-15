import { useCallback, useEffect, useRef, useState } from 'react';

interface UseApiOptions<T> {
  immediate?: boolean;
  onSuccess?: (data: T) => void;
  onError?: (error: string) => void;
}

interface UseApiReturn<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  /** 重新请求；传 true 时请求方（fetcher）应绕过前端 GET 缓存强制刷新 */
  execute: (force?: boolean) => Promise<void>;
}

export function useApi<T>(
  fetcher: (force?: boolean) => Promise<T>,
  deps: unknown[] = [],
  options: UseApiOptions<T> = {},
): UseApiReturn<T> {
  const { immediate = true, onSuccess, onError } = options;
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(immediate);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const depsRef = useRef(deps);
  depsRef.current = deps;

  const execute = useCallback(async (force = false) => {
    if (!mountedRef.current) return;
    setLoading(true);
    setError(null);
    try {
      const result = await fetcher(force);
      if (!mountedRef.current) return;
      setData(result);
      onSuccess?.(result);
    } catch (err) {
      if (!mountedRef.current) return;
      const message = err instanceof Error ? err.message : '请求失败';
      setError(message);
      onError?.(message);
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, [fetcher, onSuccess, onError]);

  useEffect(() => {
    mountedRef.current = true;
    if (immediate) {
      execute();
    }
    return () => {
      mountedRef.current = false;
    };
  }, [execute, immediate]);

  return { data, loading, error, execute };
}

interface UseSaveActionOptions {
  onSuccess?: () => void;
  onError?: (error: string) => void;
  successMessage?: string;
  errorMessage?: string;
}

interface UseSaveActionReturn {
  saving: boolean;
  execute: (action: () => Promise<void>) => Promise<void>;
}

export function useSaveAction(options: UseSaveActionOptions = {}): UseSaveActionReturn {
  const { onSuccess, onError, successMessage, errorMessage } = options;
  const [saving, setSaving] = useState(false);

  const execute = useCallback(
    async (action: () => Promise<void>) => {
      setSaving(true);
      try {
        await action();
        onSuccess?.();
        if (successMessage) {
          console.log(successMessage);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : '操作失败';
        onError?.(message);
        if (errorMessage) {
          console.error(errorMessage);
        }
      } finally {
        setSaving(false);
      }
    },
    [onSuccess, onError, successMessage, errorMessage],
  );

  return { saving, execute };
}
