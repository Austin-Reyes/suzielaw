import type { Pool } from 'pg';

export interface ObservabilityLogger {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
}

export interface AttachObservabilityOptions {
  logger?: ObservabilityLogger;
  /** How often to emit pool metrics. Default 30s. Set to 0 to disable. */
  metricsIntervalMs?: number;
}

/**
 * Wires pool-level observability: periodic metrics emit, error logging,
 * connection lifecycle. Returns a detach function the server should call on
 * shutdown.
 *
 * Per-query slow-log lives at the Kysely plugin layer — pg doesn't emit a
 * 'query' event so we can't intercept here. Pair this with pg_stat_statements
 * (already in the Postgres extension allowlist) for SQL-level analysis.
 */
export function attachPoolObservability(
  pool: Pool,
  opts: AttachObservabilityOptions = {},
): () => void {
  const log = opts.logger ?? console;
  const intervalMs = opts.metricsIntervalMs ?? 30_000;

  let interval: NodeJS.Timeout | null = null;
  if (intervalMs > 0) {
    interval = setInterval(() => {
      log.info('[db] pool', {
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount,
      });
    }, intervalMs);
    interval.unref?.();
  }

  const onError = (err: Error): void => {
    log.warn('[db] pool error', { err: err.message, stack: err.stack });
  };
  pool.on('error', onError);

  return (): void => {
    if (interval) clearInterval(interval);
    pool.off('error', onError);
  };
}
