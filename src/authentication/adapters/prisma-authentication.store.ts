import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import { parseRole } from '../../identity/domain/workspace-access.js';
import { databaseErrorCode } from '../../persistence/database-errors.js';
import type { AuthenticationStore, ReplacePasswordInput, SessionLookup, StoredCredential } from '../application/ports.js';
import { AuthenticationError } from '../domain/errors.js';
import type { ActiveSession, SessionSettings } from '../domain/session.js';

/** Limites técnicos da transação interativa (não são metas operacionais). */
export const TRANSACTION_MAX_WAIT_MS = 5_000;
export const TRANSACTION_TIMEOUT_MS = 10_000;

/** Trigger que impede reativar sessão: a sessão expirou durante a própria renovação. */
const RESTRICT_VIOLATION = '23001';

type Client = Pick<PrismaClient, '$queryRaw' | '$executeRaw'>;

interface SessionRow {
  sessionId: string;
  identityId: string;
  profile: string;
  workspaceId: string | null;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
}

function toSession(row: SessionRow): ActiveSession {
  return Object.freeze({ ...row, profile: parseRole(row.profile) });
}

/**
 * Adaptador PostgreSQL/Prisma. O relógio do banco é a única referência de tempo. Login, troca de
 * senha e encerramento geral são serializados pela linha da credencial, em READ COMMITTED: depois
 * da espera, cada instrução seguinte enxerga o que a outra transação confirmou.
 */
export class PrismaAuthenticationStore implements AuthenticationStore {
  constructor(private readonly client: PrismaClient) {}

  findCustomerCredential(alias: string, email: string): Promise<StoredCredential | null> {
    return this.guard(async () => {
      const rows = await this.client.$queryRaw<StoredCredential[]>`
        SELECT i."id"::text AS "identityId", c."hash"
          FROM "workspace" w
          JOIN "user_identity" i ON i."workspace_id" = w."id" AND i."profile" = 'CUSTOMER'
          JOIN "password_credential" c ON c."identity_id" = i."id"
         WHERE w."alias" = ${alias} AND i."email" = ${email} AND i."status" = 'ACTIVE'`;
      return rows[0] ?? null;
    });
  }

  findFacilitatorCredential(email: string): Promise<StoredCredential | null> {
    return this.guard(async () => {
      const rows = await this.client.$queryRaw<StoredCredential[]>`
        SELECT i."id"::text AS "identityId", c."hash"
          FROM "user_identity" i
          JOIN "password_credential" c ON c."identity_id" = i."id"
         WHERE i."profile" = 'FACILITATOR' AND i."email" = ${email} AND i."status" = 'ACTIVE'`;
      return rows[0] ?? null;
    });
  }

  findCredential(identityId: string): Promise<StoredCredential | null> {
    return this.guard(async () => {
      const rows = await this.client.$queryRaw<StoredCredential[]>`
        SELECT "identity_id"::text AS "identityId", "hash"
          FROM "password_credential" WHERE "identity_id" = ${identityId}::uuid`;
      return rows[0] ?? null;
    });
  }

  openSession(verified: StoredCredential, tokenHash: string, settings: SessionSettings): Promise<ActiveSession | null> {
    return this.transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ hash: string }[]>`
        SELECT "hash" FROM "password_credential" WHERE "identity_id" = ${verified.identityId}::uuid FOR SHARE`;
      if (locked[0]?.hash !== verified.hash) {
        return null;
      }
      return this.insertSession(tx, verified.identityId, tokenHash, settings);
    });
  }

  touchSession(tokenHash: string, settings: SessionSettings): Promise<SessionLookup> {
    return this.guard(async () => {
      try {
        const rows = await this.client.$queryRaw<SessionRow[]>`
          UPDATE "user_session" s
             SET "last_activity_at" = greatest(s."last_activity_at", t."now"),
                 "idle_expires_at" = least(t."now" + make_interval(mins => ${settings.idleMinutes}::int), s."absolute_expires_at")
            FROM "user_identity" i, (SELECT clock_timestamp() AS "now") t
           WHERE s."token_hash" = ${tokenHash}
             AND i."id" = s."identity_id" AND i."status" = 'ACTIVE'
             AND s."revoked_at" IS NULL
             AND s."idle_expires_at" > clock_timestamp() AND s."absolute_expires_at" > clock_timestamp()
          RETURNING s."id"::text AS "sessionId", i."id"::text AS "identityId", i."profile"::text AS "profile",
                    i."workspace_id"::text AS "workspaceId", s."idle_expires_at" AS "idleExpiresAt",
                    s."absolute_expires_at" AS "absoluteExpiresAt"`;
        if (rows[0] !== undefined) {
          return toSession(rows[0]);
        }
      } catch (error) {
        if (databaseErrorCode(error) !== RESTRICT_VIOLATION) {
          throw error;
        }
      }
      const ended = await this.client.$queryRaw<{ expired: boolean }[]>`
        SELECT s."revoked_at" IS NULL AND i."status" = 'ACTIVE' AS "expired"
          FROM "user_session" s JOIN "user_identity" i ON i."id" = s."identity_id"
         WHERE s."token_hash" = ${tokenHash}`;
      return ended[0]?.expired === true ? 'EXPIRED' : 'INVALID';
    });
  }

  revokeSession(tokenHash: string): Promise<void> {
    return this.guard(async () => {
      await this.client.$executeRaw`
        UPDATE "user_session" SET "revoked_at" = clock_timestamp()
         WHERE "token_hash" = ${tokenHash} AND "revoked_at" IS NULL
           AND "idle_expires_at" > clock_timestamp() AND "absolute_expires_at" > clock_timestamp()`;
    });
  }

  revokeAllSessions(identityId: string, tokenHash: string): Promise<boolean> {
    return this.transaction(async (tx) => {
      await this.lockCredential(tx, identityId);
      if (!(await this.isActive(tx, identityId, tokenHash))) {
        return false;
      }
      await this.revokeActive(tx, identityId);
      return true;
    });
  }

  replacePassword(input: ReplacePasswordInput): Promise<ActiveSession | 'CREDENTIAL_CHANGED' | 'SESSION_ENDED'> {
    const { identityId, hash } = input.verified;
    return this.transaction(async (tx) => {
      const current = await this.lockCredential(tx, identityId);
      if (!(await this.isActive(tx, identityId, input.currentTokenHash))) {
        return 'SESSION_ENDED';
      }
      if (current !== hash) {
        return 'CREDENTIAL_CHANGED';
      }
      await tx.$executeRaw`
        UPDATE "password_credential" SET "hash" = ${input.newHash}, "updated_at" = clock_timestamp()
         WHERE "identity_id" = ${identityId}::uuid`;
      await this.revokeActive(tx, identityId);
      const session = await this.insertSession(tx, identityId, input.newTokenHash, input.settings);
      if (session === null) {
        // Identidade desativada: reverte tudo.
        throw new AuthenticationError('SESSION_INVALID');
      }
      return session;
    });
  }

  private async lockCredential(tx: Client, identityId: string): Promise<string | undefined> {
    const rows = await tx.$queryRaw<{ hash: string }[]>`
      SELECT "hash" FROM "password_credential" WHERE "identity_id" = ${identityId}::uuid FOR UPDATE`;
    return rows[0]?.hash;
  }

  private async isActive(tx: Client, identityId: string, tokenHash: string): Promise<boolean> {
    // Trava a sessão: um logout concorrente ou já ocorreu, ou espera o fim desta transação.
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id"::text AS "id" FROM "user_session"
       WHERE "token_hash" = ${tokenHash} AND "identity_id" = ${identityId}::uuid AND "revoked_at" IS NULL
         AND "idle_expires_at" > clock_timestamp() AND "absolute_expires_at" > clock_timestamp()
         FOR UPDATE`;
    return rows.length === 1;
  }

  private async revokeActive(tx: Client, identityId: string): Promise<void> {
    await tx.$executeRaw`
      UPDATE "user_session" SET "revoked_at" = clock_timestamp()
       WHERE "identity_id" = ${identityId}::uuid AND "revoked_at" IS NULL
         AND "idle_expires_at" > clock_timestamp() AND "absolute_expires_at" > clock_timestamp()`;
  }

  private async insertSession(
    tx: Client,
    identityId: string,
    tokenHash: string,
    settings: SessionSettings,
  ): Promise<ActiveSession | null> {
    const rows = await tx.$queryRaw<SessionRow[]>`
      WITH opened AS (
        INSERT INTO "user_session"
          ("identity_id", "token_hash", "created_at", "last_activity_at", "idle_expires_at", "absolute_expires_at")
        SELECT i."id", ${tokenHash}, t."now", t."now",
               t."now" + make_interval(mins => ${settings.idleMinutes}::int),
               t."now" + make_interval(mins => ${settings.absoluteMinutes}::int)
          FROM "user_identity" i, (SELECT clock_timestamp() AS "now") t
         WHERE i."id" = ${identityId}::uuid AND i."status" = 'ACTIVE'
        RETURNING "id", "identity_id", "idle_expires_at", "absolute_expires_at"
      )
      SELECT o."id"::text AS "sessionId", i."id"::text AS "identityId", i."profile"::text AS "profile",
             i."workspace_id"::text AS "workspaceId", o."idle_expires_at" AS "idleExpiresAt",
             o."absolute_expires_at" AS "absoluteExpiresAt"
        FROM opened o JOIN "user_identity" i ON i."id" = o."identity_id"`;
    return rows[0] === undefined ? null : toSession(rows[0]);
  }

  private transaction<T>(work: (tx: Client) => Promise<T>): Promise<T> {
    return this.guard(() =>
      this.client.$transaction(work, {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: TRANSACTION_MAX_WAIT_MS,
        timeout: TRANSACTION_TIMEOUT_MS,
      }),
    );
  }

  private async guard<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      throw error instanceof AuthenticationError
        ? error
        : new AuthenticationError('AUTHENTICATION_FAILED', databaseErrorCode(error));
    }
  }
}
