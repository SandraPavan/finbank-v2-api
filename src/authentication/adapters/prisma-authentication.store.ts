import { insertAudit } from '../../audit/adapters/insert-audit.js';
import type { AuditOperation } from '../../audit/domain/audit.js';
import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import { parseRole } from '../../identity/domain/workspace-access.js';
import { databaseErrorCode } from '../../persistence/database-errors.js';
import type { AuthenticationStore, CompleteRecoveryInput, ReplacePasswordInput, SessionLookup, StoredCredential } from '../application/ports.js';
import { AuthenticationError } from '../domain/errors.js';
import type { ActiveSession, SessionScope, SessionSettings } from '../domain/session.js';

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
  scope: string;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
}

function toSession(row: SessionRow): ActiveSession {
  return Object.freeze({ ...row, profile: parseRole(row.profile), scope: row.scope === 'NORMAL' ? 'NORMAL' : 'PASSWORD_CHANGE' });
}

/** Uma única credencial vale por vez: a senha ou, se invalidada, a temporária ainda utilizável. */
const CREDENTIAL = Prisma.sql`
  CASE WHEN c."invalidated_at" IS NULL THEN c."hash" ELSE t."hash" END AS "hash", t."id"::text AS "temporaryId"`;
const USABLE = Prisma.sql`
  JOIN "password_credential" c ON c."identity_id" = i."id"
  LEFT JOIN LATERAL (
    SELECT x."id", x."hash" FROM "temporary_credential" x
     WHERE x."identity_id" = i."id" AND x."consumed_at" IS NULL AND x."revoked_at" IS NULL AND x."expires_at" > clock_timestamp()
     ORDER BY x."issued_at" DESC LIMIT 1
  ) t ON c."invalidated_at" IS NOT NULL
  WHERE (c."invalidated_at" IS NULL OR t."id" IS NOT NULL) AND i."status" = 'ACTIVE'`;

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
        SELECT i."id"::text AS "identityId", ${CREDENTIAL}
          FROM "workspace" w
          JOIN "user_identity" i ON i."workspace_id" = w."id" AND i."profile" = 'CUSTOMER'
          ${USABLE} AND w."alias" = ${alias} AND i."email" = ${email}`;
      return rows[0] ?? null;
    });
  }

  findFacilitatorCredential(email: string): Promise<StoredCredential | null> {
    return this.guard(async () => {
      const rows = await this.client.$queryRaw<StoredCredential[]>`
        SELECT i."id"::text AS "identityId", ${CREDENTIAL}
          FROM "user_identity" i
          ${USABLE} AND i."profile" = 'FACILITATOR' AND i."email" = ${email}`;
      return rows[0] ?? null;
    });
  }

  findCredential(identityId: string): Promise<StoredCredential | null> {
    return this.guard(async () => {
      const rows = await this.client.$queryRaw<StoredCredential[]>`
        SELECT "identity_id"::text AS "identityId", "hash", NULL AS "temporaryId"
          FROM "password_credential" WHERE "identity_id" = ${identityId}::uuid AND "invalidated_at" IS NULL`;
      return rows[0] ?? null;
    });
  }

  findConsumedTemporaryHash(identityId: string): Promise<string | null> {
    return this.guard(async () => {
      const rows = await this.client.$queryRaw<{ hash: string }[]>`
        SELECT "hash" FROM "temporary_credential"
         WHERE "identity_id" = ${identityId}::uuid AND "consumed_at" IS NOT NULL ORDER BY "consumed_at" DESC LIMIT 1`;
      return rows[0]?.hash ?? null;
    });
  }

  openSession(verified: StoredCredential, tokenHash: string, settings: SessionSettings, correlationId: string): Promise<ActiveSession | null> {
    const { temporaryId } = verified;
    if (temporaryId !== null) {
      return this.openRestricted(verified, temporaryId, tokenHash, settings, correlationId);
    }
    return this.transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ hash: string }[]>`
        SELECT "hash" FROM "password_credential"
         WHERE "identity_id" = ${verified.identityId}::uuid AND "invalidated_at" IS NULL FOR SHARE`;
      if (locked[0]?.hash !== verified.hash) {
        return null;
      }
      return this.insertSession(tx, verified.identityId, tokenHash, 'NORMAL', settings);
    });
  }

  private async openRestricted(
    verified: StoredCredential,
    temporaryId: string,
    tokenHash: string,
    settings: SessionSettings,
    correlationId: string,
  ): Promise<ActiveSession | null> {
    try {
      return await this.transaction(async (tx) => {
        await this.lockCredential(tx, verified.identityId);
        let consumed: number;
        try {
          consumed = await tx.$executeRaw`
            UPDATE "temporary_credential" SET "consumed_at" = clock_timestamp()
             WHERE "id" = ${temporaryId}::uuid AND "identity_id" = ${verified.identityId}::uuid AND "hash" = ${verified.hash}
               AND "consumed_at" IS NULL AND "revoked_at" IS NULL AND "expires_at" > clock_timestamp()`;
        } catch (error) {
          if (databaseErrorCode(error) === RESTRICT_VIOLATION) {
            throw new AuthenticationError('INVALID_CREDENTIALS');
          }
          throw error;
        }
        const session = consumed === 1 ? await this.insertSession(tx, verified.identityId, tokenHash, 'PASSWORD_CHANGE', settings) : null;
        if (session === null) {
          // Desfaz o consumo se a identidade foi desativada.
          throw new AuthenticationError('INVALID_CREDENTIALS');
        }
        await this.audit(tx, session, 'TEMPORARY_CREDENTIAL_CONSUME', correlationId);
        return session;
      });
    } catch (error) {
      if (error instanceof AuthenticationError && error.code === 'INVALID_CREDENTIALS') {
        return null;
      }
      throw error;
    }
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
                    i."workspace_id"::text AS "workspaceId", s."scope"::text AS "scope", s."idle_expires_at" AS "idleExpiresAt",
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
      if (!(await this.isActive(tx, identityId, input.currentTokenHash, 'NORMAL'))) {
        return 'SESSION_ENDED';
      }
      if (current !== hash) {
        return 'CREDENTIAL_CHANGED';
      }
      await tx.$executeRaw`
        UPDATE "password_credential" SET "hash" = ${input.newHash}, "updated_at" = clock_timestamp()
         WHERE "identity_id" = ${identityId}::uuid`;
      await this.revokeActive(tx, identityId);
      const session = await this.insertSession(tx, identityId, input.newTokenHash, 'NORMAL', input.settings);
      if (session === null) {
        // Identidade desativada: reverte tudo.
        throw new AuthenticationError('SESSION_INVALID');
      }
      await this.audit(tx, session, 'PASSWORD_CHANGE', input.correlationId);
      return session;
    });
  }

  completeRecovery(input: CompleteRecoveryInput): Promise<ActiveSession | 'SESSION_ENDED'> {
    const { identityId } = input;
    return this.transaction(async (tx) => {
      await this.lockCredential(tx, identityId);
      if (!(await this.isActive(tx, identityId, input.currentTokenHash, 'PASSWORD_CHANGE'))) {
        return 'SESSION_ENDED';
      }
      await tx.$executeRaw`
        UPDATE "password_credential" SET "hash" = ${input.newHash}, "updated_at" = clock_timestamp(), "invalidated_at" = NULL
         WHERE "identity_id" = ${identityId}::uuid`;
      await this.revokeActive(tx, identityId);
      const session = await this.insertSession(tx, identityId, input.newTokenHash, 'NORMAL', input.settings);
      if (session === null) {
        throw new AuthenticationError('SESSION_INVALID');
      }
      await this.audit(tx, session, 'PASSWORD_RECOVERY_COMPLETE', input.correlationId);
      return session;
    });
  }

  private audit(tx: Client, session: ActiveSession, operation: AuditOperation, correlationId: string): Promise<void> {
    return insertAudit(tx, {
      actor: { type: 'IDENTITY', identityId: session.identityId, profile: session.profile },
      workspaceId: session.workspaceId,
      operation,
      resource: 'IDENTITY',
      resourceId: session.identityId,
      changed: true,
      correlationId,
    });
  }

  /** Trava a linha e devolve o hash da senha, se ainda válida. */
  private async lockCredential(tx: Client, identityId: string): Promise<string | undefined> {
    const rows = await tx.$queryRaw<{ hash: string; valid: boolean }[]>`
      SELECT "hash", "invalidated_at" IS NULL AS "valid" FROM "password_credential" WHERE "identity_id" = ${identityId}::uuid FOR UPDATE`;
    return rows[0]?.valid === true ? rows[0].hash : undefined;
  }

  private async isActive(tx: Client, identityId: string, tokenHash: string, scope: SessionScope | null = null): Promise<boolean> {
    // Trava a sessão: um logout concorrente ou já ocorreu, ou espera o fim desta transação.
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id"::text AS "id" FROM "user_session"
       WHERE "token_hash" = ${tokenHash} AND "identity_id" = ${identityId}::uuid AND "revoked_at" IS NULL
         AND (${scope}::"session_scope" IS NULL OR "scope" = ${scope}::"session_scope")
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
    scope: SessionScope,
    settings: SessionSettings,
  ): Promise<ActiveSession | null> {
    const rows = await tx.$queryRaw<SessionRow[]>`
      WITH opened AS (
        INSERT INTO "user_session"
          ("identity_id", "token_hash", "scope", "created_at", "last_activity_at", "idle_expires_at", "absolute_expires_at")
        SELECT i."id", ${tokenHash}, ${scope}::"session_scope", t."now", t."now",
               t."now" + make_interval(mins => ${settings.idleMinutes}::int),
               t."now" + make_interval(mins => ${settings.absoluteMinutes}::int)
          FROM "user_identity" i, (SELECT clock_timestamp() AS "now") t
         WHERE i."id" = ${identityId}::uuid AND i."status" = 'ACTIVE'
        RETURNING "id", "identity_id", "scope", "idle_expires_at", "absolute_expires_at"
      )
      SELECT o."id"::text AS "sessionId", i."id"::text AS "identityId", i."profile"::text AS "profile",
             i."workspace_id"::text AS "workspaceId", o."scope"::text AS "scope", o."idle_expires_at" AS "idleExpiresAt",
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
