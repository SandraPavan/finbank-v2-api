// Crédito educacional por HTTP pelo facilitador vinculado: limites, idempotência, registro e auditoria.
import type { WorkspaceAccess } from '../../identity/domain/workspace-access.js';
import { formatAmount, parseCreditRequest, parseIdempotencyKey } from '../domain/educational-credit.js';

export interface CreditLimits {
  readonly maxPerOperationCents: bigint;
  readonly maxPerAccountCents: bigint;
}

export interface CreditInput {
  readonly customerId: string;
  /** Chave do pedido; o adaptador deriva a chave do núcleo com o ator (ADR 011). */
  readonly idempotencyKey: string;
  readonly amountCents: bigint;
  readonly justification: string;
  readonly limits: CreditLimits;
}

export interface StoredCredit {
  readonly creditId: string;
  readonly operationId: string;
  readonly accountId: string;
  readonly amountCents: bigint;
}

export type CreditResult =
  | { readonly kind: 'CREDITED'; readonly credit: StoredCredit; readonly replayed: boolean }
  | { readonly kind: 'NOT_FOUND' | 'DENIED' | 'ARCHIVED' | 'BLOCKED' | 'LIMIT' | 'CONFLICT' };

/** Porta de persistência. */
export interface EducationalCreditStore {
  /**
   * Numa transação: vínculo e workspace reconferidos; conta pelo vínculo cliente–conta; contrapartida garantida;
   * repetição devolvida antes dos limites; crédito pelo PaymentExecution com o teto acumulado sob a trava da conta;
   * registro e auditoria. Repetição com outra justificativa ou de outro autor é conflito.
   */
  credit(access: WorkspaceAccess, input: CreditInput, correlationId: string): Promise<CreditResult>;
}

export interface CreditView {
  readonly creditId: string;
  readonly operationId: string;
  readonly workspaceId: string;
  readonly customerId: string;
  readonly accountId: string;
  readonly amount: string;
  readonly replayed: boolean;
}

export type EducationalCreditErrorCode = 'NOT_FOUND' | 'ACCESS_LOST' | 'WORKSPACE_ARCHIVED' | 'ACCOUNT_BLOCKED' | 'LIMIT_EXCEEDED' | 'IDEMPOTENCY_CONFLICT';

export class EducationalCreditError extends Error {
  constructor(readonly code: EducationalCreditErrorCode) {
    super(`Crédito recusado: ${code}.`);
    this.name = 'EducationalCreditError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class EducationalCreditService {
  constructor(
    private readonly store: EducationalCreditStore,
    private readonly limits: CreditLimits,
  ) {}

  async credit(access: WorkspaceAccess, rawCustomerId: unknown, rawKey: unknown, body: unknown, correlationId: string): Promise<CreditView> {
    const idempotencyKey = parseIdempotencyKey(rawKey);
    const { amountCents, justification } = parseCreditRequest(body);
    if (typeof rawCustomerId !== 'string' || !UUID.test(rawCustomerId)) {
      throw new EducationalCreditError('NOT_FOUND');
    }
    const result = await this.store.credit(access, { customerId: rawCustomerId, idempotencyKey, amountCents, justification, limits: this.limits }, correlationId);
    switch (result.kind) {
      case 'CREDITED':
        return Object.freeze({
          creditId: result.credit.creditId,
          operationId: result.credit.operationId,
          workspaceId: access.workspaceId,
          customerId: rawCustomerId,
          accountId: result.credit.accountId,
          amount: formatAmount(result.credit.amountCents),
          replayed: result.replayed,
        });
      case 'NOT_FOUND':
        throw new EducationalCreditError('NOT_FOUND');
      case 'DENIED':
        throw new EducationalCreditError('ACCESS_LOST');
      case 'ARCHIVED':
        throw new EducationalCreditError('WORKSPACE_ARCHIVED');
      case 'BLOCKED':
        throw new EducationalCreditError('ACCOUNT_BLOCKED');
      case 'LIMIT':
        throw new EducationalCreditError('LIMIT_EXCEEDED');
      case 'CONFLICT':
        throw new EducationalCreditError('IDEMPOTENCY_CONFLICT');
    }
  }
}
