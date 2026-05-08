import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import type { SessionUser } from '../hooks/use-session.js';

interface Props {
  user: SessionUser | null;
  loading: boolean;
  children: ReactNode;
}

export function Protected({ user, loading, children }: Props) {
  const location = useLocation();

  if (loading && !user) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
        Loading session…
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  return <>{children}</>;
}
