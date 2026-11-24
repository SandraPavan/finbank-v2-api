import { createHash } from 'node:crypto';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { databaseErrorCode } from '../../persistence/database-errors.js';
import type { AttemptStore } from '../application/attempt-limiter.js';
import { AuthenticationError } from '../domain/errors.js';
import type { LoginLimits } from '../domain/login-limits.js';

/** Linhas vencidas removidas a cada falha. */
const CLEANUP_BATCH = 20;

/** Contador em PostgreSQL: sobrevive a reinício e usa só o relógio do banco. Falha do banco nega. */
export class PrismaAttemptStore implements AttemptStore {
  constructor(private readonly client: PrismaClient) {}

  restrictionSeconds(subject: string): Promise<number | null> {
    return this.guard(async () => {
      const rows = await this.client.$queryRaw<{ seconds: number }[]>`
        SELECT greatest(1, ceil(extract(epoch FROM "restricted_until" - clock_timestamp())))::int AS "seconds"
          FROM "authentication_control"
         WHERE "subject_hash" = ${hash(subject)} AND "restricted_until" > clock_timestamp()`;
      return rows[0]?.seconds ?? null;
    });
  }

  registerFailure(subject: string, limits: LoginLimits): Promise<void> {
    const { maxAttempts, windowMinutes, restrictionSeconds, maxRestrictionSeconds } = limits;
    return this.guard(async () => {
      // "now" é o window_started_at proposto. Contador vencido recomeça; senão soma e, a partir do
      // limite, restringe por base × 2^(falhas − limite), até o máximo. Com restrição, o contador só
      // vence uma janela depois do fim dela.
      await this.client.$executeRaw`
        INSERT INTO "authentication_control" AS c
          ("subject_hash", "failures", "window_started_at", "restricted_until", "expires_at")
        SELECT ${hash(subject)}, 1, t."now",
               CASE WHEN ${maxAttempts}::int <= 1 THEN t."now" + make_interval(secs => ${restrictionSeconds}::int) END,
               t."now" + make_interval(mins => ${windowMinutes}::int)
                 + CASE WHEN ${maxAttempts}::int <= 1 THEN make_interval(secs => ${restrictionSeconds}::int) ELSE interval '0' END
          FROM (SELECT clock_timestamp() AS "now") t
        ON CONFLICT ("subject_hash") DO UPDATE SET
          ("failures", "window_started_at", "restricted_until", "expires_at") = (
            SELECT n."failures", n."started", n."until",
                   coalesce(n."until", n."started") + make_interval(mins => ${windowMinutes}::int)
              FROM (
                SELECT p."failures", p."started",
                       CASE WHEN p."failures" >= ${maxAttempts}::int THEN
                         EXCLUDED."window_started_at" + make_interval(secs => least(
                           ${maxRestrictionSeconds}::int,
                           ${restrictionSeconds}::int * power(2, least(p."failures" - ${maxAttempts}::int, 20))))
                       END AS "until"
                  FROM (
                    SELECT CASE WHEN c."expires_at" <= EXCLUDED."window_started_at" THEN 1 ELSE c."failures" + 1 END AS "failures",
                           CASE WHEN c."expires_at" <= EXCLUDED."window_started_at"
                                THEN EXCLUDED."window_started_at" ELSE c."window_started_at" END AS "started"
                  ) p
              ) n
          )`;
      await this.cleanup();
    });
  }

  clear(subject: string): Promise<void> {
    return this.guard(async () => {
      await this.client.$executeRaw`DELETE FROM "authentication_control" WHERE "subject_hash" = ${hash(subject)}`;
    });
  }

  private async cleanup(): Promise<void> {
    await this.client.$executeRaw`
      DELETE FROM "authentication_control" WHERE "subject_hash" IN (
        SELECT "subject_hash" FROM "authentication_control"
         WHERE "expires_at" <= clock_timestamp() ORDER BY "expires_at" LIMIT ${CLEANUP_BATCH}
           FOR UPDATE SKIP LOCKED)`;
  }

  private async guard<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      throw new AuthenticationError('AUTHENTICATION_FAILED', databaseErrorCode(error));
    }
  }
}

function hash(subject: string): string {
  return createHash('sha256').update(subject).digest('hex');
}
