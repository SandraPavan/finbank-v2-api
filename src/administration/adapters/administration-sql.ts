import type { Prisma } from '../../generated/prisma/client.js';

export type Transaction = Prisma.TransactionClient;

export const TRANSACTION_OPTIONS = { isolationLevel: 'ReadCommitted', maxWait: 5_000, timeout: 10_000 } as const;

export { lockFacilitatorChange, lockFacilitatorUse } from '../../persistence/facilitator-locks.js';
