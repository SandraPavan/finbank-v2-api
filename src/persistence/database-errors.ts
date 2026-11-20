const SAFE_CODE = /^[A-Za-z0-9_]{2,40}$/;

/**
 * Erro sanitizado de indisponibilidade do banco. Não carrega a causa original,
 * URL, host, porta, usuário ou senha; expõe apenas um código técnico em allowlist.
 */
export class DatabaseUnavailableError extends Error {
  readonly code: string | undefined;

  constructor(code: string | undefined) {
    super(`Banco de dados indisponível${code ? ` (${code})` : ''}.`);
    this.name = 'DatabaseUnavailableError';
    this.code = code;
  }
}

export function toDatabaseUnavailableError(error: unknown): DatabaseUnavailableError {
  return new DatabaseUnavailableError(databaseErrorCode(error));
}

/** Código técnico do erro (SQLSTATE do PostgreSQL quando disponível), em allowlist e sem a mensagem. */
export function databaseErrorCode(error: unknown): string | undefined {
  return driverAdapterCode(error) ?? causeChainCode(error);
}

function safe(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_CODE.test(value) ? value : undefined;
}

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined;
}

// Erros do Prisma com driver adapter: meta.driverAdapterError.cause traz
// `originalCode` (código do PostgreSQL, ex.: 28P01) e `kind` (ex.: DatabaseNotReachable),
// junto de host/porta, que são descartados.
function driverAdapterCode(error: unknown): string | undefined {
  const cause = field(field(field(error, 'meta'), 'driverAdapterError'), 'cause');
  return safe(field(cause, 'originalCode')) ?? safe(field(cause, 'kind'));
}

function causeChainCode(error: unknown, depth = 0): string | undefined {
  if (depth > 3 || typeof error !== 'object' || error === null) {
    return undefined;
  }
  return safe(field(error, 'code')) ?? causeChainCode(field(error, 'cause'), depth + 1);
}
