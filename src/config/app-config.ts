export const DEFAULT_PORT = 3000;
const MIN_PORT = 1;
const MAX_PORT = 65_535;

export interface AppConfig {
  readonly port: number;
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
  return { port: parsePort(env['PORT']) };
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
