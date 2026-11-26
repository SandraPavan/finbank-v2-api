import type { Prisma } from '../generated/prisma/client.js';

const workspaceKey = (id: string): string => `finbank:workspace:${id}`;

/**
 * Uso do workspace (movimentação, alteração do relógio): convive com outros usos e espera o arquivamento,
 * que pedirá a trava exclusiva. Consultiva porque a execução não tem UPDATE no workspace.
 */
export async function lockWorkspaceUse(tx: Pick<Prisma.TransactionClient, '$executeRaw'>, id: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended(${workspaceKey(id)}, 0))`;
}
