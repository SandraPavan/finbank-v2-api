export const DEFAULT_PORT = 3000;
const MIN_PORT = 1;
const MAX_PORT = 65_535;
const DATABASE_PROTOCOLS = new Set(['postgres:', 'postgresql:']);

export interface AppConfig {
  readonly port: number;
  readonly databaseUrl: string;
}

export class InvalidConfigError extends Error {
  readonly variable: string;

  constructor(variable: string, expectation: string) {
    super(`Configuração inválida: ${variable} ${expectation}.`);
    this.name = 'InvalidConfigError';
    this.variable = variable;
  }
}

export function loadAppConfig(env: Readonly<Record<string, string | undefined>>): AppConfig {
  return {
    port: parsePort(env['PORT']),
    databaseUrl: parseDatabaseUrl(env['DATABASE_URL']),
  };
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined) {
    return DEFAULT_PORT;
  }
  if (!/^[0-9]+$/.test(raw)) {
    throw new InvalidConfigError('PORT', `deve ser um inteiro entre ${MIN_PORT} e ${MAX_PORT}`);
  }
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    throw new InvalidConfigError('PORT', `deve ser um inteiro entre ${MIN_PORT} e ${MAX_PORT}`);
  }
  return port;
}

// O valor nunca é incluído na mensagem: pode conter credenciais.
function parseDatabaseUrl(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === '') {
    throw new InvalidConfigError('DATABASE_URL', 'é obrigatória');
  }
  const expectation = 'deve ser uma URL postgres:// ou postgresql:// com host';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new InvalidConfigError('DATABASE_URL', expectation);
  }
  if (!DATABASE_PROTOCOLS.has(url.protocol) || url.hostname === '') {
    throw new InvalidConfigError('DATABASE_URL', expectation);
  }
  return raw;
}
