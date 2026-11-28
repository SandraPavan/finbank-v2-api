// Consulta da conta, do saldo e do extrato: o cliente vê a própria conta; o facilitador vinculado, a de um cliente do workspace.
import type { WorkspaceAccess } from '../../identity/domain/workspace-access.js';
import type { BankAccountStatus } from '../domain/account-status.js';
import { encodeCursor, type LedgerLine, parseStatementQuery, type StatementItem, type StatementPosition, toStatementItem } from '../domain/statement.js';
import { BankAccountError, formatBalance, parseCustomerId } from './bank-account.service.js';

export interface OwnAccountView {
  readonly accountId: string;
  readonly status: BankAccountStatus;
  /** Saldo materializado, em reais com duas casas. */
  readonly balance: string;
  readonly currency: 'BRL';
}

export interface StatementPage {
  readonly accountId: string;
  /** Do mais recente para o mais antigo. */
  readonly items: readonly StatementItem[];
  /** Continuação; null na última página. */
  readonly nextCursor: string | null;
}

/** Porta de leitura: somente consulta, sempre restrita ao workspace e à conta informados. */
export interface AccountStatementReader {
  /** Conta comum do cliente no workspace; null se ele não tem conta neste workspace. */
  account(workspaceId: string, customerId: string): Promise<{ accountId: string; status: BankAccountStatus; balance: bigint } | null>;
  /** Até `limit` lançamentos da conta, do mais recente ao mais antigo, depois da posição informada. */
  entries(workspaceId: string, accountId: string, limit: number, after: StatementPosition | null): Promise<readonly LedgerLine[]>;
}

export class AccountStatementService {
  constructor(private readonly reader: AccountStatementReader) {}

  /** Conta do próprio cliente: o identificador é o da identidade confirmada pela guarda, nunca um recebido. */
  async ownAccount(access: WorkspaceAccess): Promise<OwnAccountView> {
    const found = await this.find(access.workspaceId, access.identityId);
    return Object.freeze({ accountId: found.accountId, status: found.status, balance: formatBalance(found.balance), currency: 'BRL' });
  }

  ownStatement(access: WorkspaceAccess, query: Readonly<Record<string, unknown>>): Promise<StatementPage> {
    return this.statement(access.workspaceId, access.identityId, query);
  }

  async customerStatement(access: WorkspaceAccess, rawCustomerId: unknown, query: Readonly<Record<string, unknown>>): Promise<StatementPage> {
    return this.statement(access.workspaceId, parseCustomerId(rawCustomerId), query);
  }

  private async statement(workspaceId: string, customerId: string, query: Readonly<Record<string, unknown>>): Promise<StatementPage> {
    const { limit, after } = parseStatementQuery(query);
    const { accountId } = await this.find(workspaceId, customerId);
    // Um a mais revela se há continuação.
    const lines = await this.reader.entries(workspaceId, accountId, limit + 1, after);
    const page = lines.slice(0, limit);
    const last = page.at(-1);
    return Object.freeze({
      accountId,
      items: page.map(toStatementItem),
      nextCursor: lines.length > limit && last !== undefined ? encodeCursor({ occurredAt: last.occurredAt, entryId: last.entryId }) : null,
    });
  }

  private async find(workspaceId: string, customerId: string) {
    const found = await this.reader.account(workspaceId, customerId);
    if (found === null) {
      throw new BankAccountError('NOT_FOUND');
    }
    return found;
  }
}
