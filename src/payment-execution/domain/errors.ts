// Erros tipados da execução financeira. As mensagens são fixas por código e nunca
// incluem valores recebidos, identificadores, chaves de operação ou saldos.

export const PAYMENT_EXECUTION_ERROR_CODES = [
  'INVALID_INPUT',
  'AMOUNT_OUT_OF_RANGE',
  'SAME_ACCOUNT',
  'ACCOUNT_NOT_FOUND',
  'ACCOUNT_BLOCKED',
  'ACCOUNT_NOT_ELIGIBLE',
  'WORKSPACE_ARCHIVED',
  'CONTRA_ACCOUNT_MISSING',
  'WORKSPACE_NOT_FOUND',
  'DUPLICATE_CONTRA_ACCOUNT',
  'INSUFFICIENT_FUNDS',
  'IDEMPOTENCY_CONFLICT',
  'OPERATION_NOT_FOUND',
  'NOT_REVERSIBLE',
  'ALREADY_REVERSED',
  'EXECUTION_FAILED',
] as const;

export type PaymentExecutionErrorCode = (typeof PAYMENT_EXECUTION_ERROR_CODES)[number];

const MESSAGES: Record<PaymentExecutionErrorCode, string> = {
  INVALID_INPUT: 'Entrada inválida',
  AMOUNT_OUT_OF_RANGE: 'Valor fora do limite técnico suportado',
  SAME_ACCOUNT: 'Conta de origem e de destino devem ser diferentes',
  ACCOUNT_NOT_FOUND: 'Conta não encontrada no workspace',
  WORKSPACE_NOT_FOUND: 'Workspace não encontrado',
  ACCOUNT_BLOCKED: 'Conta bloqueada para movimentações',
  ACCOUNT_NOT_ELIGIBLE: 'Conta não pode receber esta operação',
  WORKSPACE_ARCHIVED: 'Workspace arquivado não aceita movimentações',
  CONTRA_ACCOUNT_MISSING: 'O workspace não possui conta de contrapartida',
  DUPLICATE_CONTRA_ACCOUNT: 'O workspace já possui conta de contrapartida',
  INSUFFICIENT_FUNDS: 'Saldo insuficiente',
  IDEMPOTENCY_CONFLICT: 'Chave de operação já utilizada com conteúdo diferente',
  OPERATION_NOT_FOUND: 'Operação não encontrada no workspace',
  NOT_REVERSIBLE: 'Operação não pode ser estornada',
  ALREADY_REVERSED: 'Operação já estornada',
  EXECUTION_FAILED: 'Falha ao executar a operação',
};

const SAFE_TECHNICAL_CODE = /^[A-Za-z0-9_]{2,40}$/;

export interface PaymentExecutionErrorDetails {
  /** Campo rejeitado (somente para INVALID_INPUT) e a regra violada; nunca o valor. */
  readonly field?: string;
  readonly expectation?: string;
  /** Código técnico em allowlist (ex.: SQLSTATE), sem mensagem do driver. */
  readonly technicalCode?: string;
  readonly cause?: unknown;
}

export class PaymentExecutionError extends Error {
  readonly code: PaymentExecutionErrorCode;
  readonly field: string | undefined;
  readonly technicalCode: string | undefined;

  constructor(code: PaymentExecutionErrorCode, details: PaymentExecutionErrorDetails = {}) {
    const suffix = details.field ? `: ${details.field} ${details.expectation ?? 'inválido'}` : '';
    super(`${MESSAGES[code]}${suffix}.`, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'PaymentExecutionError';
    this.code = code;
    this.field = details.field;
    this.technicalCode =
      details.technicalCode !== undefined && SAFE_TECHNICAL_CODE.test(details.technicalCode)
        ? details.technicalCode
        : undefined;
  }
}

export function invalidInput(field: string, expectation: string): PaymentExecutionError {
  return new PaymentExecutionError('INVALID_INPUT', { field, expectation });
}
