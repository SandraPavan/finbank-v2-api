// Erros das operações do operador. Mensagens fixas, sem valores recebidos nem causa original.

export type AdministrationErrorCode =
  | 'ALREADY_EXISTS'
  | 'NOT_FOUND'
  | 'FACILITATOR_DISABLED'
  | 'MEMBERSHIP_REVOKED'
  | 'ADMINISTRATION_FAILED';

const MESSAGES: Record<AdministrationErrorCode, string> = {
  ALREADY_EXISTS: 'Já existe; nada foi alterado',
  NOT_FOUND: 'Workspace, identidade ou vínculo não encontrado; nada foi alterado',
  FACILITATOR_DISABLED: 'O facilitador está desativado; nada foi alterado (use facilitator enable)',
  MEMBERSHIP_REVOKED: 'O vínculo está revogado; nada foi alterado (use membership grant)',
  ADMINISTRATION_FAILED: 'Falha na operação; nada foi alterado',
};

const SAFE_TECHNICAL_CODE = /^[A-Za-z0-9_]{2,40}$/;

export class AdministrationError extends Error {
  readonly code: AdministrationErrorCode;

  constructor(code: AdministrationErrorCode, technicalCode?: string) {
    const suffix = technicalCode !== undefined && SAFE_TECHNICAL_CODE.test(technicalCode) ? ` (${technicalCode})` : '';
    super(`${MESSAGES[code]}${suffix}.`);
    this.name = 'AdministrationError';
    this.code = code;
  }
}
