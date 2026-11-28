import type { PrismaClient } from '../../generated/prisma/client.js';
import { IdentityError } from '../../identity/domain/errors.js';
import { readAccountEntries, readCustomerAccount } from '../../payment-execution/adapters/prisma-account-ledger.reader.js';
import { databaseErrorCode } from '../../persistence/database-errors.js';
import type { AccountStatementReader } from '../application/account-statement.service.js';
import type { BankAccountStatus } from '../domain/account-status.js';
import type { LedgerLine, StatementPosition } from '../domain/statement.js';

/** Leitura pelo PaymentExecution, dono do ledger; falha de banco vira falha de verificação tipada, sem detalhes. */
export class PrismaAccountStatementReader implements AccountStatementReader {
  constructor(private readonly client: PrismaClient) {}

  account(workspaceId: string, customerId: string): Promise<{ accountId: string; status: BankAccountStatus; balance: bigint } | null> {
    return this.guard(async () => {
      const found = await readCustomerAccount(this.client, workspaceId, customerId);
      if (found !== null && found.status !== 'ACTIVE' && found.status !== 'BLOCKED') {
        throw new IdentityError('ACCESS_CHECK_FAILED');
      }
      return found;
    });
  }

  entries(workspaceId: string, accountId: string, limit: number, after: StatementPosition | null): Promise<readonly LedgerLine[]> {
    return this.guard(() => readAccountEntries(this.client, workspaceId, accountId, limit, after));
  }

  private async guard<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof IdentityError) {
        throw error;
      }
      throw new IdentityError('ACCESS_CHECK_FAILED', databaseErrorCode(error));
    }
  }
}
