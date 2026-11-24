// Erros tipados da autenticação. Mensagens fixas, sem valores recebidos nem causa original.
// INVALID_CREDENTIALS é o mesmo para qualquer motivo de recusa do login.

export type AuthenticationErrorCode =
  | 'INVALID_CREDENTIALS'
  | 'SESSION_INVALID'
  | 'SESSION_EXPIRED'
  | 'PASSWORD_POLICY'
  | 'AUTHENTICATION_FAILED';

const MESSAGES: Record<AuthenticationErrorCode, string> = {
  INVALID_CREDENTIALS: 'Credenciais inválidas',
  SESSION_INVALID: 'Sessão inválida',
  SESSION_EXPIRED: 'Sessão expirada',
  PASSWORD_POLICY: 'A senha deve ter de 12 a 128 caracteres',
  AUTHENTICATION_FAILED: 'Falha ao processar a autenticação',
};

const SAFE_TECHNICAL_CODE = /^[A-Za-z0-9_]{2,40}$/;

export class AuthenticationError extends Error {
  readonly code: AuthenticationErrorCode;
  readonly technicalCode: string | undefined;

  constructor(code: AuthenticationErrorCode, technicalCode?: string) {
    super(`${MESSAGES[code]}.`);
    this.name = 'AuthenticationError';
    this.code = code;
    this.technicalCode =
      technicalCode !== undefined && SAFE_TECHNICAL_CODE.test(technicalCode) ? technicalCode : undefined;
  }
}
