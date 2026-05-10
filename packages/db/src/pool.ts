import { Pool, type PoolConfig } from 'pg';
import { DefaultAzureCredential, type TokenCredential } from '@azure/identity';

const AAD_SCOPE = 'https://ossrdbms-aad.database.windows.net/.default';

// Refresh tokens before they expire so a connection-burst doesn't 429 AAD
// AND so no connection ever uses a token that's about to expire mid-handshake.
const TOKEN_REFRESH_HEADROOM_MS = 5 * 60_000;

// Recycle idle connections at 30 min so the next checkout gets a fresh token.
const POOL_IDLE_TIMEOUT_MS = 30 * 60_000;

// Hard kill connections at 50 min — Postgres AAD tokens have a 60-min TTL
// and pg's `password` callback only runs on NEW connection. Without
// maxLifetime, long-lived connections start failing AAD validation at 60 min.
const POOL_MAX_LIFETIME_S = 50 * 60;

export interface AadPoolOptions {
  host: string;
  database: string;
  /** The managed identity / AAD principal name configured on the server via pgaadauth_create_principal. */
  user: string;
  port?: number;
  ssl?: PoolConfig['ssl'];
  max?: number;
  applicationName?: string;
  /** Override the credential. Useful for tests or for swapping in a chained credential. */
  credential?: TokenCredential;
}

export interface StaticPoolOptions {
  host: string;
  database: string;
  user: string;
  password: string;
  port?: number;
  ssl?: PoolConfig['ssl'];
  max?: number;
  applicationName?: string;
}

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

export function createAadPool(opts: AadPoolOptions): Pool {
  const credential = opts.credential ?? new DefaultAzureCredential();
  let cached: CachedToken | null = null;
  let inFlight: Promise<string> | null = null;

  const fetchToken = async (): Promise<string> => {
    if (cached && Date.now() < cached.expiresAtMs - TOKEN_REFRESH_HEADROOM_MS) {
      return cached.token;
    }
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const t = await credential.getToken(AAD_SCOPE);
      if (!t) throw new Error(`AAD token fetch returned null for scope ${AAD_SCOPE}`);
      cached = { token: t.token, expiresAtMs: t.expiresOnTimestamp };
      return t.token;
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  return new Pool({
    host: opts.host,
    database: opts.database,
    user: opts.user,
    port: opts.port ?? 5432,
    password: fetchToken,
    ssl: opts.ssl ?? { rejectUnauthorized: true },
    max: opts.max ?? 10,
    idleTimeoutMillis: POOL_IDLE_TIMEOUT_MS,
    maxLifetimeSeconds: POOL_MAX_LIFETIME_S,
    application_name: opts.applicationName,
  });
}

export function createStaticPool(opts: StaticPoolOptions): Pool {
  return new Pool({
    host: opts.host,
    database: opts.database,
    user: opts.user,
    port: opts.port ?? 5432,
    password: opts.password,
    ssl: opts.ssl ?? false,
    max: opts.max ?? 10,
    idleTimeoutMillis: POOL_IDLE_TIMEOUT_MS,
    application_name: opts.applicationName,
  });
}
