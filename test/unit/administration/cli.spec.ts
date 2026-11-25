import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { parseCommand, USAGE, UsageError } from '../../../src/administration/cli/arguments.js';
import { readPassword } from '../../../src/administration/cli/password-input.js';
import { runCommand } from '../../../src/administration/cli/run-command.js';
import { OperatorService } from '../../../src/administration/application/operator.service.js';
import type { OperatorStore } from '../../../src/administration/application/operator.store.js';

const PASSWORD = 'senha  com espaços é 12';

describe('argumentos da linha de comando', () => {
  it('aceita exatamente os comandos documentados', () => {
    expect(parseCommand(['bootstrap', '--alias', 'turma', '--email', 'a@b'])).toEqual({ name: 'bootstrap', alias: 'turma', email: 'a@b' });
    expect(parseCommand(['workspace', 'create', '--alias=turma'])).toEqual({ name: 'workspace create', alias: 'turma', email: '' });
    for (const name of ['facilitator disable', 'facilitator enable', 'facilitator create']) {
      expect(parseCommand([...name.split(' '), '--email', 'a@b']).name).toBe(name);
    }
  });

  it.each([
    [[]], [['bootstrap']], [['bootstrap', '--alias', 'x']], [['facilitator']], [['facilitator', 'remove', '--email', 'a@b']],
    [['workspace', 'create', '--alias', 'a', '--alias', 'b']], [['workspace', 'create', '--alias', 'a', '--email', 'a@b']],
    [['workspace', 'create', '--alias']], [['workspace', 'create', 'extra', '--alias', 'a']], [['toString']], [['customer', 'disable', '--email', 'a@b']],
    [['facilitator', 'create', '--email', 'a@b', '--password', PASSWORD]], [['facilitator', 'create', '--email', 'a@b', `--password=${PASSWORD}`]],
    [['facilitator', 'create', '--email', 'a@b', '-p', PASSWORD]], [['facilitator', 'create', '--email', 'a@b', PASSWORD]],
  ])('recusa %j sem repetir valores', (args) => {
    const error = (() => {
      try {
        parseCommand(args);
        return undefined;
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(UsageError);
    expect((error as Error).message).toBe('Comando inválido');
  });

  it('o uso não oferece opção de senha', () => {
    expect(USAGE).not.toMatch(/--(password|senha)|-p /);
  });
});

function terminal() {
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn() });
  const notices: string[] = [];
  const result = readPassword({ input: input as unknown as NodeJS.ReadStream, notice: (t) => notices.push(t) });
  result.catch(() => undefined);
  return { input, notices, result };
}

function piped(...chunks: (string | Buffer)[]) {
  const input = new PassThrough();
  chunks.forEach((c) => input.write(c));
  input.end();
  return readPassword({ input: input as unknown as NodeJS.ReadStream, notice: () => undefined });
}

describe('senha no terminal', () => {
  it('lê duas vezes sem eco e restaura o modo do terminal', async () => {
    const t = terminal();
    t.input.write(`${PASSWORD}x\u007f\r`);
    await new Promise((r) => setImmediate(r));
    t.input.write(`${PASSWORD}\n`);
    expect(await t.result).toBe(PASSWORD);
    expect(t.notices.join('')).not.toContain(PASSWORD);
    expect(t.input.setRawMode.mock.calls).toEqual([[true], [false]]);
  });

  it('texto colado com as duas linhas é aceito', async () => {
    const t = terminal();
    t.input.write(`${PASSWORD}\r${PASSWORD}\r`);
    expect(await t.result).toBe(PASSWORD);
  });

  it.each([
    ['diferentes', `${PASSWORD}\r${PASSWORD}x\r`, 'As senhas não coincidem'],
    ['Ctrl+C', `${PASSWORD}\u0003`, 'Cancelado'],
    ['Ctrl+D', '\u0004', 'Cancelado'],
    ['enorme', 'x'.repeat(2000), 'Senha longa demais'],
  ])('%s: recusa e restaura o terminal', async (_label, typed, message) => {
    const t = terminal();
    t.input.write(typed);
    await expect(t.result).rejects.toThrow(message);
    expect(t.input.setRawMode).toHaveBeenLastCalledWith(false);
  });

  it('terminal fechado cancela', async () => {
    const t = terminal();
    t.input.end();
    await expect(t.result).rejects.toThrow('Cancelado');
  });
});

describe('senha na entrada padrão', () => {
  it.each([[PASSWORD], [`${PASSWORD}\n`], [`${PASSWORD}\r\n`]])('aceita %j sem alterar a senha', async (text) => {
    expect(await piped(text)).toBe(PASSWORD);
  });

  it('caractere dividido entre blocos é preservado', async () => {
    const bytes = Buffer.from(PASSWORD);
    const cut = bytes.indexOf(0xc3) + 1;
    expect(await piped(bytes.subarray(0, cut), bytes.subarray(cut))).toBe(PASSWORD);
  });

  it.each([
    [null], ['\n'], [`${PASSWORD}\noutra\n`], [`${PASSWORD}\n\n`], ['x'.repeat(1025)], [Buffer.from([0xff, 0xfe, 0x41])],
  ])('recusa entrada que não é uma linha válida', async (content) => {
    await expect(content === null ? piped() : piped(content)).rejects.toBeInstanceOf(UsageError);
  });
});

describe('execução do comando', () => {
  function setup(exists: boolean) {
    const store = {
      facilitatorExists: vi.fn(() => Promise.resolve(exists)),
      bootstrap: vi.fn(() => Promise.resolve({ workspaceCreated: true, facilitatorCreated: !exists, membershipCreated: true })),
      createFacilitator: vi.fn(() => Promise.resolve()),
      setMembership: vi.fn(() => Promise.resolve(false)),
    };
    const hasher = { hash: vi.fn(() => Promise.resolve('hash')), verify: vi.fn() };
    const service = new OperatorService({ store: store as unknown as OperatorStore, hasher, generator: { generate: () => 'x' }, temporaryCredentialHours: 24, correlationId: 'correlacao' });
    return { store, hasher, service, password: vi.fn(() => Promise.resolve(PASSWORD)) };
  }

  it('bootstrap sobre facilitador existente não pede senha', async () => {
    const s = setup(true);
    const message = await runCommand(s.service, { name: 'bootstrap', alias: 'turma', email: 'A@B' }, s.password);
    expect(message).toBe('workspace: criado; facilitador: já existia; vínculo: criado');
    expect(s.password).not.toHaveBeenCalled();
    expect(s.store.bootstrap).toHaveBeenCalledWith({ alias: 'turma', email: 'a@b', hash: null, correlationId: 'correlacao' });
  });

  it('entrada inválida não pede senha nem toca o banco', async () => {
    const s = setup(false);
    await expect(runCommand(s.service, { name: 'bootstrap', alias: 'X', email: 'a@b' }, s.password)).rejects.toMatchObject({ code: 'INVALID_ALIAS' });
    await expect(runCommand(s.service, { name: 'facilitator create', alias: '', email: 'x' }, s.password)).rejects.toMatchObject({ code: 'INVALID_EMAIL' });
    expect(s.password).not.toHaveBeenCalled();
    expect(s.store.facilitatorExists).not.toHaveBeenCalled();
  });

  it('senha fora da política não é gravada', async () => {
    const s = setup(false);
    s.password.mockResolvedValue('curta');
    await expect(s.service.createFacilitator('a@b', s.password)).rejects.toMatchObject({ code: 'PASSWORD_POLICY' });
    expect(s.hasher.hash).not.toHaveBeenCalled();
    expect(s.store.createFacilitator).not.toHaveBeenCalled();
  });

  it('repetição informa que nada mudou', async () => {
    const s = setup(true);
    expect(await runCommand(s.service, { name: 'membership revoke', alias: 'turma', email: 'a@b' }, s.password)).toMatch(/sem mudança/);
  });
});
