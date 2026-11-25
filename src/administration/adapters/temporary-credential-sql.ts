import type { Transaction } from './administration-sql.js';

/**
 * Emite a credencial: revoga a anterior, invalida a senha e encerra as sessões. A linha da credencial
 * permanente serializa com login, troca de senha e conclusão da recuperação. Null se não há senha cadastrada.
 */
export async function issueTemporaryCredential(tx: Transaction, identityId: string, hash: string, hours: number): Promise<Date | null> {
  const locked = await tx.$queryRaw<unknown[]>`
    SELECT 1 AS "ok" FROM "password_credential" WHERE "identity_id" = ${identityId}::uuid FOR UPDATE`;
  if (locked.length !== 1) {
    return null;
  }
  await tx.$executeRaw`
    UPDATE "temporary_credential" SET "revoked_at" = clock_timestamp()
     WHERE "identity_id" = ${identityId}::uuid AND "consumed_at" IS NULL AND "revoked_at" IS NULL AND "expires_at" > clock_timestamp()`;
  await tx.$executeRaw`
    UPDATE "password_credential" SET "invalidated_at" = clock_timestamp()
     WHERE "identity_id" = ${identityId}::uuid AND "invalidated_at" IS NULL`;
  await tx.$executeRaw`
    UPDATE "user_session" SET "revoked_at" = clock_timestamp()
     WHERE "identity_id" = ${identityId}::uuid AND "revoked_at" IS NULL
       AND "idle_expires_at" > clock_timestamp() AND "absolute_expires_at" > clock_timestamp()`;
  const rows = await tx.$queryRaw<{ expiresAt: Date }[]>`
    INSERT INTO "temporary_credential" ("identity_id", "hash", "expires_at")
    VALUES (${identityId}::uuid, ${hash}, clock_timestamp() + make_interval(hours => ${hours}::int))
    RETURNING "expires_at" AS "expiresAt"`;
  return rows[0]?.expiresAt ?? null;
}
