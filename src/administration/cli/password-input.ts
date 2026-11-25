import type { ReadStream } from 'node:tty';
import { UsageError } from './arguments.js';

/** Folga sobre a política (128 caracteres de até 4 bytes), para não acumular entrada sem limite. */
const MAX_BYTES = 1024;

export interface PasswordTerminal {
  readonly input: NodeJS.ReadStream;
  /** Avisos e perguntas; nunca a senha. */
  readonly notice: (text: string) => void;
}

/** Terminal: duas leituras sem eco. Sem terminal: exatamente uma linha da entrada padrão. */
export async function readPassword({ input, notice }: PasswordTerminal): Promise<string> {
  if (!input.isTTY) {
    return readLine(input);
  }
  const terminal = input;
  const reader = hiddenReader(terminal);
  try {
    notice('Senha (12 a 128 caracteres): ');
    const first = await reader.line();
    notice('\nRepita a senha: ');
    const second = await reader.line();
    notice('\n');
    if (first !== second) {
      throw new UsageError('As senhas não coincidem');
    }
    return first;
  } finally {
    reader.close();
  }
}

async function readLine(input: NodeJS.ReadStream): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of input) {
    const bytes = Buffer.from(chunk as Buffer);
    size += bytes.length;
    if (size > MAX_BYTES) {
      throw new UsageError('Senha longa demais na entrada padrão');
    }
    chunks.push(bytes);
  }
  const text = decode(Buffer.concat(chunks)).replace(/\r?\n$/, '');
  if (text === '' || /[\r\n]/.test(text)) {
    throw new UsageError('A entrada padrão deve conter exatamente uma linha com a senha');
  }
  return text;
}

function decode(bytes: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new UsageError('A senha deve estar em UTF-8');
  }
}

/** Uma só escuta para as duas leituras: texto colado com as duas linhas não se perde nem ecoa. */
function hiddenReader(terminal: ReadStream): { line(): Promise<string>; close(): void } {
  const lines: string[] = [];
  let typed: string[] = [];
  let failure: UsageError | undefined;
  let waiting: (() => void) | undefined;
  const wake = (): void => {
    waiting?.();
    waiting = undefined;
  };
  const fail = (message: string): void => {
    failure ??= new UsageError(message);
  };
  const onData = (chunk: string): void => {
    for (const char of chunk) {
      if (char === '\r' || char === '\n') {
        lines.push(typed.join(''));
        typed = [];
      } else if (char === '\u0003' || char === '\u0004') {
        fail('Cancelado');
      } else if (char === '\u007f' || char === '\b') {
        typed.pop();
      } else {
        typed.push(char);
        if (typed.length > MAX_BYTES) {
          fail('Senha longa demais');
        }
      }
    }
    wake();
  };
  const onEnd = (): void => {
    fail('Cancelado');
    wake();
  };
  terminal.setRawMode(true);
  terminal.setEncoding('utf8');
  terminal.on('data', onData);
  terminal.on('end', onEnd);
  terminal.resume();
  return {
    async line(): Promise<string> {
      while (failure === undefined && lines.length === 0) {
        await new Promise<void>((resolve) => (waiting = resolve));
      }
      if (failure !== undefined) {
        throw failure;
      }
      return lines.shift() ?? '';
    },
    close(): void {
      terminal.off('data', onData);
      terminal.off('end', onEnd);
      terminal.setRawMode(false);
      terminal.pause();
    },
  };
}
