// Administração da conta do cliente pelo facilitador vinculado: consulta, bloqueio e desbloqueio.
import type { WorkspaceAccess } from '../../identity/domain/workspace-access.js';
import type { BankAccountStatus } from '../domain/account-status.js';

export interface StatusChangeRecord {
  readonly fromStatus: BankAccountStatus;
  readonly toStatus: BankAccountStatus;
  readonly justification: string;
  readonly changedBy: string;
  readonly changedAt: string;
}

export interface CustomerAccountView {
  readonly workspaceId: string;
  readonly customerId: string;
  readonly accountId: string;
  readonly status: BankAccountStatus;
  /** Do mais recente para o mais antigo. */
  readonly history: readonly StatusChangeRecord[];
}

export interface AccountStateView {
  readonly workspaceId: string;
  readonly customerId: string;
  readonly accountId: string;
  readonly status: BankAccountStatus;
}

export type StatusChangeResult =
  | { readonly kind: 'CHANGED' | 'UNCHANGED'; readonly accountId: string; readonly status: BankAccountStatus }
  | { readonly kind: 'NOT_FOUND' | 'DENIED' | 'ARCHIVED' };

/** Porta de persistência. */
export interface BankAccountStore {
  /** Conta do cliente no workspace, com o histórico; null se o cliente não tem conta neste workspace. */
  view(workspaceId: string, customerId: string): Promise<Omit<CustomerAccountView, 'workspaceId'> | null>;
  /**
   * Numa transação: reconfere vínculo e workspace, trava a conta como as movimentações e muda o estado só se for outro,
   * gravando histórico e auditoria. O mesmo estado não grava nada.
   */
  change(access: WorkspaceAccess, customerId: string, status: BankAccountStatus, justification: string, correlationId: string): Promise<StatusChangeResult>;
}

export type BankAccountErrorCode = 'NOT_FOUND' | 'ACCESS_LOST' | 'WORKSPACE_ARCHIVED';

export class BankAccountError extends Error {
  constructor(readonly code: BankAccountErrorCode) {
    super(`Conta recusada: ${code}.`);
    this.name = 'BankAccountError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function customer(raw: unknown): string {
  if (typeof raw !== 'string' || !UUID.test(raw)) {
    throw new BankAccountError('NOT_FOUND');
  }
  return raw;
}

export class BankAccountService {
  constructor(private readonly store: BankAccountStore) {}

  async view(access: WorkspaceAccess, rawCustomerId: unknown): Promise<CustomerAccountView> {
    const found = await this.store.view(access.workspaceId, customer(rawCustomerId));
    if (found === null) {
      throw new BankAccountError('NOT_FOUND');
    }
    return Object.freeze({ workspaceId: access.workspaceId, ...found });
  }

  async change(access: WorkspaceAccess, rawCustomerId: unknown, status: BankAccountStatus, justification: string, correlationId: string): Promise<AccountStateView> {
    const customerId = customer(rawCustomerId);
    const result = await this.store.change(access, customerId, status, justification, correlationId);
    switch (result.kind) {
      case 'CHANGED':
      case 'UNCHANGED':
        return Object.freeze({ workspaceId: access.workspaceId, customerId, accountId: result.accountId, status: result.status });
      case 'NOT_FOUND':
        throw new BankAccountError('NOT_FOUND');
      case 'DENIED':
        throw new BankAccountError('ACCESS_LOST');
      case 'ARCHIVED':
        throw new BankAccountError('WORKSPACE_ARCHIVED');
    }
  }
}
