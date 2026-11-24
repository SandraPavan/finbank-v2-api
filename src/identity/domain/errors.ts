// Erros tipados de identidade e acesso a workspaces. Mensagens fixas por código, sem valores recebidos.
// ACCESS_DENIED é o mesmo para qualquer motivo de negação: não revela o que existe.

export type IdentityErrorCode = 'INVALID_INPUT' | 'INVALID_EMAIL' | 'INVALID_ALIAS' | 'ACCESS_DENIED' | 'ACCESS_CHECK_FAILED';

const MESSAGES: Record<IdentityErrorCode, string> = {
  INVALID_INPUT: 'Entrada inválida: identificadores devem ser UUID em minúsculas',
  INVALID_EMAIL: 'E-mail inválido',
  INVALID_ALIAS: 'Alias de workspace inválido',
  ACCESS_DENIED: 'Acesso negado ao workspace',
  ACCESS_CHECK_FAILED: 'Falha ao verificar o acesso ao workspace',
};

const SAFE_TECHNICAL_CODE = /^[A-Za-z0-9_]{2,40}$/;

/** Não carrega a causa original: a falha do banco só expõe um código técnico em allowlist. */
export class IdentityError extends Error {
  readonly code: IdentityErrorCode;
  readonly technicalCode: string | undefined;

  constructor(code: IdentityErrorCode, technicalCode?: string) {
    super(`${MESSAGES[code]}.`);
    this.name = 'IdentityError';
    this.code = code;
    this.technicalCode =
      technicalCode !== undefined && SAFE_TECHNICAL_CODE.test(technicalCode) ? technicalCode : undefined;
  }
}
