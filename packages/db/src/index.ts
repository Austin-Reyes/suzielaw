import { Kysely, PostgresDialect } from 'kysely';
import type { Pool } from 'pg';
import { attachPoolObservability, type ObservabilityLogger } from './observability.js';
import type { DB } from './types.js';

export interface CreateDbOptions {
  pool: Pool;
  logger?: ObservabilityLogger;
  /** Disable pool metrics emit. Default false. */
  disableObservability?: boolean;
}

export interface DbHandle {
  kysely: Kysely<DB>;
  pool: Pool;
  /** Tear down the pool + observability. Idempotent. */
  close: () => Promise<void>;
}

export function createDb(opts: CreateDbOptions): DbHandle {
  const detach = opts.disableObservability
    ? (): void => {}
    : attachPoolObservability(opts.pool, { logger: opts.logger });

  const kysely = new Kysely<DB>({
    dialect: new PostgresDialect({ pool: opts.pool }),
  });

  let closed = false;
  return {
    kysely,
    pool: opts.pool,
    close: async (): Promise<void> => {
      if (closed) return;
      closed = true;
      detach();
      // Kysely's PostgresDialect.destroy() calls pool.end() under the hood.
      await kysely.destroy();
    },
  };
}

export type { DB, AppAuditLogTable, DbMetadataTable } from './types.js';
export type { ObservabilityLogger } from './observability.js';
export { attachPoolObservability } from './observability.js';
export { createAadPool, createStaticPool } from './pool.js';
export type { AadPoolOptions, StaticPoolOptions } from './pool.js';
export {
  withRequestContext,
  getRequestContext,
  requireRequestContext,
} from './requestContext.js';
export type { RequestContext } from './requestContext.js';
