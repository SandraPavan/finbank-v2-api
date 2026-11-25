import type { Prisma } from '../../generated/prisma/client.js';
import type { AuditEntry } from '../domain/audit.js';

/** Grava na transação da própria operação. Sem RETURNING: a execução não lê a auditoria. */
export async function insertAudit(tx: Pick<Prisma.TransactionClient, '$executeRaw'>, entry: AuditEntry): Promise<void> {
  const identityId = entry.actor.type === 'IDENTITY' ? entry.actor.identityId : null;
  const profile = entry.actor.type === 'IDENTITY' ? entry.actor.profile : null;
  await tx.$executeRaw`
    INSERT INTO "audit_record"
      ("actor_type", "actor_identity_id", "actor_profile", "workspace_id", "operation", "resource_type", "resource_id", "result", "correlation_id")
    VALUES (${entry.actor.type}::"audit_actor_type", ${identityId}::uuid, ${profile}::"membership_role", ${entry.workspaceId}::uuid,
            ${entry.operation}, ${entry.resource}, ${entry.resourceId}::uuid,
            ${entry.changed ? 'CHANGED' : 'UNCHANGED'}::"audit_result", ${entry.correlationId})`;
}
