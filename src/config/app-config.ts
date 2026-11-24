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

export const COOKIE_TRANSPORTS = ['secure', 'local-http'] as const;
/** `secure` exige HTTPS; `local-http` é só para uso local e só atende endereços de loopback. */
export type CookieTransport = (typeof COOKIE_TRANSPORTS)[number];

export interface LoginLimitsConfig {
  readonly maxAttempts: number;
  readonly windowMinutes: number;
  readonly restrictionSeconds: number;
  readonly maxRestrictionSeconds: number;
}

export interface AppConfig {
  readonly port: number;
  readonly databaseUrl: string;
  readonly session: SessionConfig;
  readonly loginLimits: LoginLimitsConfig;
  readonly cookieTransport: CookieTransport;
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
    loginLimits: parseLoginLimits(env),
    cookieTransport: parseCookieTransport(env['COOKIE_TRANSPORT']),
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

function parseLoginLimits(env: Readonly<Record<string, string | undefined>>): LoginLimitsConfig {
  const integer = (variable: string, fallback: number, max: number) => parseInteger(variable, env[variable], fallback, max);
  const limits = {
    maxAttempts: integer('LOGIN_MAX_ATTEMPTS', 5, 100),
    windowMinutes: integer('LOGIN_WINDOW_MINUTES', 15, 1440),
    restrictionSeconds: integer('LOGIN_RESTRICTION_SECONDS', 30, 3600),
    maxRestrictionSeconds: integer('LOGIN_MAX_RESTRICTION_SECONDS', 900, 86_400),
  };
  if (limits.maxRestrictionSeconds < limits.restrictionSeconds) {
    throw new InvalidConfigError('LOGIN_MAX_RESTRICTION_SECONDS', 'deve ser maior ou igual a LOGIN_RESTRICTION_SECONDS');
  }
  return limits;
}

function parseCookieTransport(raw: string | undefined): CookieTransport {
  const transport = COOKIE_TRANSPORTS.find((known) => known === (raw ?? 'secure'));
  if (transport === undefined) {
    throw new InvalidConfigError('COOKIE_TRANSPORT', "deve ser 'secure' ou 'local-http'");
  }
  return transport;
}

function parseMinutes(variable: string, raw: string | undefined, fallback: number): number {
  return parseInteger(variable, raw, fallback, MAX_SESSION_MINUTES);
}

function parseInteger(variable: string, raw: string | undefined, fallback: number, max: number): number {
  if (raw === undefined) {
    return fallback;
  }
  const value = /^[0-9]{1,5}$/.test(raw) ? Number(raw) : 0;
  if (value < 1 || value > max) {
    throw new InvalidConfigError(variable, `deve ser um inteiro entre 1 e ${max}`);
  }
  return value;
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
