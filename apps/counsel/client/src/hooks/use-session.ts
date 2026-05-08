import { useCallback, useEffect, useRef, useState } from 'react';

export interface SessionUser {
  email: string;
  name: string;
  role: string;
}

export interface TokenBudgetSummary {
  tokenLimit: number;
  tokensUsed: number;
  tokensRemaining: number;
  limitReached: boolean;
}

interface SessionState {
  user: SessionUser | null;
  tokenBudget: TokenBudgetSummary | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

export function useSession(): SessionState {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [tokenBudget, setTokenBudget] = useState<TokenBudgetSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const hasLoadedRef = useRef(false);

  const refresh = useCallback(async () => {
    if (!hasLoadedRef.current) setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/session', { credentials: 'include' });
      if (!response.ok) {
        throw new Error(`Session request failed (${response.status})`);
      }
      const data = (await response.json()) as {
        user: SessionUser | null;
        tokenBudget?: TokenBudgetSummary | null;
      };
      setUser(data.user);
      setTokenBudget(data.tokenBudget ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load session');
      if (!hasLoadedRef.current) {
        setUser(null);
        setTokenBudget(null);
      }
    } finally {
      hasLoadedRef.current = true;
      setLoading(false);
    }
  }, []);

  const logout = useCallback(async () => {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    setUser(null);
    setTokenBudget(null);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { user, tokenBudget, loading, error, refresh, logout };
}
