// Erros tipados da reconciliação. Mensagens fixas por código, sem valores recebidos.

export const RECONCILIATION_ERROR_CODES = ['INVALID_INPUT', 'WORKSPACE_NOT_FOUND', 'RECONCILIATION_FAILED'] as const;

export type ReconciliationErrorCode = (typeof RECONCILIATION_ERROR_CODES)[number];

const MESSAGES: Record<ReconciliationErrorCode, string> = {
  INVALID_INPUT: 'Entrada inválida: workspaceId deve ser um UUID em minúsculas',
  WORKSPACE_NOT_FOUND: 'Workspace não encontrado',
  RECONCILIATION_FAILED: 'Falha ao reconciliar o workspace',
};

const SAFE_TECHNICAL_CODE = /^[A-Za-z0-9_]{2,40}$/;

export class ReconciliationError extends Error {
  readonly code: ReconciliationErrorCode;
  readonly technicalCode: string | undefined;

  constructor(code: ReconciliationErrorCode, details: { technicalCode?: string; cause?: unknown } = {}) {
    super(`${MESSAGES[code]}.`, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'ReconciliationError';
    this.code = code;
    this.technicalCode =
      details.technicalCode !== undefined && SAFE_TECHNICAL_CODE.test(details.technicalCode)
        ? details.technicalCode
        : undefined;
  }
}
