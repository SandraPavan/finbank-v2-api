import type { Prisma } from '../../generated/prisma/client.js';
import type { AuditEntry } from '../domain/audit.js';

export type Transaction = Prisma.TransactionClient;

export const TRANSACTION_OPTIONS = { isolationLevel: 'ReadCommitted', maxWait: 5_000, timeout: 10_000 } as const;

/** Sem RETURNING: a execução não lê a auditoria. */
export async function insertAudit(tx: Transaction, entry: AuditEntry): Promise<void> {
  const identityId = entry.actor.type === 'IDENTITY' ? entry.actor.identityId : null;
  const profile = entry.actor.type === 'IDENTITY' ? entry.actor.profile : null;
  await tx.$executeRaw`
    INSERT INTO "audit_record"
      ("actor_type", "actor_identity_id", "actor_profile", "workspace_id", "operation", "resource_type", "resource_id", "result", "correlation_id")
    VALUES (${entry.actor.type}::"audit_actor_type", ${identityId}::uuid, ${profile}::"membership_role", ${entry.workspaceId}::uuid,
            ${entry.operation}, ${entry.resource}, ${entry.resourceId}::uuid,
            ${entry.changed ? 'CHANGED' : 'UNCHANGED'}::"audit_result", ${entry.correlationId})`;
}

const facilitatorKey = (id: string): string => `finbank:facilitator:${id}`;

/** Uso do acesso do facilitador: convive com outros usos e exclui a retirada do acesso. */
export async function lockFacilitatorUse(tx: Transaction, id: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended(${facilitatorKey(id)}, 0))`;
}

/** Mudança de estado ou vínculo do facilitador: espera as operações em curso dele. */
export async function lockFacilitatorChange(tx: Transaction, id: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${facilitatorKey(id)}, 0))`;
}
