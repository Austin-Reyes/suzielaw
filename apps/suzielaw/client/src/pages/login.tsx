import { useEffect, useState, type FormEvent } from 'react';
import { Button, Card, CardContent, CardHeader } from '@teamsuzie/ui';

interface AuthProvider {
  id: string;
  label: string;
  startUrl: string;
}

function GoogleMark() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="h-5 w-5 shrink-0"
    >
      <path
        fill="#4285F4"
        d="M21.35 11.1h-9.18v2.92h5.27c-.23 1.25-.95 2.31-2.02 3.02v2.5h3.27c1.91-1.76 3.01-4.36 3.01-7.44 0-.72-.06-1.41-.17-2z"
      />
      <path
        fill="#34A853"
        d="M12.17 22c2.73 0 5.02-.9 6.69-2.44l-3.27-2.5c-.91.61-2.07.98-3.42.98-2.62 0-4.84-1.77-5.64-4.14H3.15v2.59A10 10 0 0 0 12.17 22z"
      />
      <path
        fill="#FBBC05"
        d="M6.53 13.9c-.2-.61-.31-1.26-.31-1.9s.11-1.29.31-1.9V7.5H3.15A10 10 0 0 0 2.17 12c0 1.61.38 3.13 1.04 4.5l3.32-2.6z"
      />
      <path
        fill="#EA4335"
        d="M12.17 5.96c1.49 0 2.82.51 3.87 1.51l2.9-2.9C17.18 2.92 14.89 2 12.17 2A10 10 0 0 0 3.15 7.5l3.38 2.6c.8-2.37 3.02-4.14 5.64-4.14z"
      />
    </svg>
  );
}

export function LoginPage() {
  const [providers, setProviders] = useState<AuthProvider[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [email, setEmail] = useState('demo@example.com');
  const [password, setPassword] = useState('demo');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDemoLogin(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error === 'invalid_credentials' ? 'Invalid email or password.' : 'Login failed.');
        return;
      }
      window.location.href = '/';
    } catch {
      setError('Network error.');
    } finally {
      setSubmitting(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    fetch('/api/auth/providers', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : { providers: [] }))
      .then((data: { providers?: AuthProvider[] }) => {
        if (!cancelled) {
          setProviders(data.providers ?? []);
          setLoaded(true);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setProviders([]);
          setLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted px-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <div className="text-center">
            <div className="font-display text-5xl font-medium tracking-tight text-foreground">
              RBL Counsel Assist
            </div>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {providers.map((provider) => (
            <Button
              key={provider.id}
              type="button"
              variant="outline"
              className="w-full rounded-xl border-neutral-200 bg-white px-4 py-3 text-sm font-semibold text-neutral-800 shadow-sm transition-colors hover:border-neutral-300 hover:bg-neutral-50"
              onClick={() => {
                window.location.href = provider.startUrl;
              }}
            >
              {provider.id === 'google' ? <GoogleMark /> : null}
              <span>Continue with {provider.label}</span>
            </Button>
          ))}
          {loaded && providers.length === 0 && (
            <form onSubmit={handleDemoLogin} className="flex flex-col gap-3">
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-neutral-700">Email</span>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email"
                  className="rounded-lg border border-neutral-200 px-3 py-2 text-sm shadow-sm focus:border-neutral-400 focus:outline-none"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-neutral-700">Password</span>
                <input
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  className="rounded-lg border border-neutral-200 px-3 py-2 text-sm shadow-sm focus:border-neutral-400 focus:outline-none"
                />
              </label>
              {error && <p className="text-sm text-red-600">{error}</p>}
              <Button type="submit" disabled={submitting} className="w-full rounded-xl">
                {submitting ? 'Signing in…' : 'Sign in'}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
