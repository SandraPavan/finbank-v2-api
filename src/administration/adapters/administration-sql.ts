import type { Prisma } from '../../generated/prisma/client.js';

export type Transaction = Prisma.TransactionClient;

export const TRANSACTION_OPTIONS = { isolationLevel: 'ReadCommitted', maxWait: 5_000, timeout: 10_000 } as const;

const facilitatorKey = (id: string): string => `finbank:facilitator:${id}`;

/** Uso do acesso do facilitador: convive com outros usos e exclui a retirada do acesso. */
export async function lockFacilitatorUse(tx: Transaction, id: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended(${facilitatorKey(id)}, 0))`;
}

/** Mudança de estado ou vínculo do facilitador: espera as operações em curso dele. */
export async function lockFacilitatorChange(tx: Transaction, id: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${facilitatorKey(id)}, 0))`;
}
