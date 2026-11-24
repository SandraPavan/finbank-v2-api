import { IdentityError } from './errors.js';

/** 3 a 40 caracteres a-z, 0-9 ou hífen, sem hífen nas pontas. Comparação exata, sem normalização. */
const ALIAS_PATTERN = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

/** O alias localiza um workspace; não é credencial nem autorização. */
export function parseWorkspaceAlias(raw: unknown): string {
  if (typeof raw !== 'string' || !ALIAS_PATTERN.test(raw)) {
    throw new IdentityError('INVALID_ALIAS');
  }
  return raw;
}
