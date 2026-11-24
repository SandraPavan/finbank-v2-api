import { IdentityError } from './errors.js';

export const EMAIL_MAX_LENGTH = 254;

/** ASCII visível, com um único @ e partes não vazias. Verificado antes de converter a caixa. */
const ASCII_EMAIL = /^[!-?A-~]+@[!-?A-~]+$/;

/**
 * Forma única do e-mail: sem espaços externos e em minúsculas. Não aplica regras de provedores
 * (pontos e sufixos com + são preservados). A restrição a ASCII faz a conversão coincidir com a do banco.
 */
export function normalizeEmail(raw: unknown): string {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (trimmed.length > EMAIL_MAX_LENGTH || !ASCII_EMAIL.test(trimmed)) {
    throw new IdentityError('INVALID_EMAIL');
  }
  return trimmed.toLowerCase();
}
