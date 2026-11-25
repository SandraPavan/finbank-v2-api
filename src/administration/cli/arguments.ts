import { parseArgs } from 'node:util';

export class UsageError extends Error {
  constructor(message = 'Comando inválido') {
    super(message);
    this.name = 'UsageError';
  }
}

const COMMANDS = {
  bootstrap: ['alias', 'email'],
  'workspace create': ['alias'],
  'facilitator create': ['email'],
  'facilitator disable': ['email'],
  'facilitator enable': ['email'],
  'facilitator reset': ['email'],
  'membership grant': ['alias', 'email'],
  'membership revoke': ['alias', 'email'],
  'customer create': ['alias', 'email'],
} as const satisfies Record<string, readonly ('alias' | 'email')[]>;

export type CommandName = keyof typeof COMMANDS;

export interface Command {
  readonly name: CommandName;
  readonly alias: string;
  readonly email: string;
}

export const USAGE = [
  'Uso:',
  ...Object.entries(COMMANDS).map(([name, options]) => `  ${name} ${options.map((o) => `--${o} <${o}>`).join(' ')}`),
  'A senha é pedida no terminal, sem eco, ou lida da entrada padrão (uma linha). Não há opção para informá-la.',
].join('\n');

/** Estrito: comando e opções exatos, sem repetição. As mensagens nunca repetem o que foi recebido. */
export function parseCommand(args: readonly string[]): Command {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...args],
      options: { alias: { type: 'string', multiple: true }, email: { type: 'string', multiple: true } },
      allowPositionals: true,
      strict: true,
    });
  } catch {
    throw new UsageError();
  }
  const name = parsed.positionals.join(' ');
  if (!Object.hasOwn(COMMANDS, name)) {
    throw new UsageError();
  }
  const expected: readonly string[] = COMMANDS[name as CommandName];
  for (const option of ['alias', 'email'] as const) {
    if ((parsed.values[option]?.length ?? 0) !== (expected.includes(option) ? 1 : 0)) {
      throw new UsageError();
    }
  }
  return { name: name as CommandName, alias: parsed.values.alias?.[0] ?? '', email: parsed.values.email?.[0] ?? '' };
}
