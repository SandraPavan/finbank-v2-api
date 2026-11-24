export const DEFAULT_PORT = 3000;
const MIN_PORT = 1;
const MAX_PORT = 65_535;
const DATABASE_PROTOCOLS = new Set(['postgres:', 'postgresql:']);

export const DEFAULT_SESSION_IDLE_MINUTES = 30;
export const DEFAULT_SESSION_ABSOLUTE_MINUTES = 480;
const MAX_SESSION_MINUTES = 1440;

export interface SessionConfig {
  readonly idleMinutes: number;
  readonly absoluteMinutes: number;
}

export interface AppConfig {
  readonly port: number;
  readonly databaseUrl: string;
  readonly session: SessionConfig;
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
    session: parseSession(env),
  };
}

function parseSession(env: Readonly<Record<string, string | undefined>>): SessionConfig {
  const idleMinutes = parseMinutes('SESSION_IDLE_MINUTES', env['SESSION_IDLE_MINUTES'], DEFAULT_SESSION_IDLE_MINUTES);
  const absoluteMinutes = parseMinutes(
    'SESSION_ABSOLUTE_MINUTES',
    env['SESSION_ABSOLUTE_MINUTES'],
    DEFAULT_SESSION_ABSOLUTE_MINUTES,
  );
  if (idleMinutes > absoluteMinutes) {
    throw new InvalidConfigError('SESSION_IDLE_MINUTES', 'deve ser menor ou igual a SESSION_ABSOLUTE_MINUTES');
  }
  return { idleMinutes, absoluteMinutes };
}

function parseMinutes(variable: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) {
    return fallback;
  }
  const minutes = /^[0-9]{1,4}$/.test(raw) ? Number(raw) : 0;
  if (minutes < 1 || minutes > MAX_SESSION_MINUTES) {
    throw new InvalidConfigError(variable, `deve ser um inteiro entre 1 e ${MAX_SESSION_MINUTES}`);
  }
  return minutes;
}

export function parsePort(raw: string | undefined): number {
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
