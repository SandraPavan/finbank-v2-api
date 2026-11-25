import { describe, expect, it, vi } from 'vitest';
import { AuthenticationService } from '../../../src/authentication/application/authentication.service.js';
import type { AuthenticationStore } from '../../../src/authentication/application/ports.js';
import { AuthenticationError } from '../../../src/authentication/domain/errors.js';

const PASSWORD = 'senha correta longa';
const IDENTITY = '11111111-1111-4111-8111-111111111111';

function setup(credential: { identityId: string; hash: string; temporaryId: null } | null) {
  const store = {
    findCustomerCredential: vi.fn(() => Promise.resolve(credential)),
    findFacilitatorCredential: vi.fn(() => Promise.resolve(credential)),
    findCredential: vi.fn(() => Promise.resolve(credential)),
    findConsumedTemporaryHash: vi.fn(() => Promise.resolve(null)),
    completeRecovery: vi.fn(() => Promise.resolve('SESSION_ENDED' as const)),
    openSession: vi.fn(() => Promise.resolve(null)),
    touchSession: vi.fn(() => Promise.resolve('INVALID' as const)),
    revokeSession: vi.fn(() => Promise.resolve()),
    revokeAllSessions: vi.fn(() => Promise.resolve(false)),
    replacePassword: vi.fn(() => Promise.resolve('SESSION_ENDED' as const)),
  } satisfies AuthenticationStore;
  const verify = vi.fn((password: string, hash: string) => Promise.resolve(hash === 'real' && password === PASSWORD));
  const service = new AuthenticationService({
    store,
    hasher: { hash: () => Promise.resolve('novo'), verify },
    secrets: { generate: () => 'segredo', digest: (raw) => (raw === 'segredo' ? 'resumo' : null) },
    settings: { idleMinutes: 30, absoluteMinutes: 480 },
    decoyHash: 'ficticio',
  });
  return { store, verify, service };
}

const real = { identityId: IDENTITY, hash: 'real', temporaryId: null };

describe('login', () => {
  it.each([
    ['sem credencial', null, PASSWORD, 'ficticio'],
    ['senha errada', real, 'senha errada longa', 'real'],
    ['identidade desativada durante o login', real, PASSWORD, 'real'],
  ])('%s: uma verificação Argon2id e o mesmo erro', async (_label, credential, password, hash) => {
    const { service, verify } = setup(credential);
    const error = await service.loginFacilitator({ email: 'ana@example.test', password }).catch((e: unknown) => e);
    expect(error).toEqual(new AuthenticationError('INVALID_CREDENTIALS'));
    expect(verify).toHaveBeenCalledExactlyOnceWith(password, hash);
  });

  it('nunca aceita a senha fictícia', async () => {
    const { service, store, verify } = setup(null);
    verify.mockResolvedValue(true);
    await expect(service.loginFacilitator({ email: 'a@b', password: PASSWORD })).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    expect(store.openSession).not.toHaveBeenCalled();
  });

  it('normaliza o e-mail e não altera alias nem senha', async () => {
    const { service, store, verify } = setup(real);
    const password = '  Senha Com Espaços  ';
    await service.loginCustomer({ alias: 'turma-a', email: ' Ana@Example.TEST ', password }).catch(() => undefined);
    expect(store.findCustomerCredential).toHaveBeenCalledWith('turma-a', 'ana@example.test');
    expect(verify).toHaveBeenCalledWith(password, 'real');
  });

  it.each([
    { alias: 'X', email: 'a@b', password: PASSWORD },
    { alias: 'turma-a', email: 'x', password: PASSWORD },
    { alias: 'turma-a', email: 'a@b', password: 'curta' },
    { alias: 'turma-a', email: 'a@b', password: undefined },
    { alias: undefined, email: undefined, password: undefined },
  ])('entrada malformada é credencial inválida, sem consultar: %j', async (input) => {
    const { service, store, verify } = setup(real);
    await expect(service.loginCustomer(input)).rejects.toEqual(new AuthenticationError('INVALID_CREDENTIALS'));
    expect(store.findCustomerCredential).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
  });
});

describe('sessão', () => {
  it('segredo malformado é sessão inválida em todas as operações, sem consultar', async () => {
    const { service, store } = setup(real);
    for (const op of [
      () => service.validate('x'), () => service.logout(undefined), () => service.logoutAll({}),
      () => service.changePassword(null, PASSWORD, PASSWORD),
    ]) {
      await expect(op()).rejects.toMatchObject({ code: 'SESSION_INVALID' });
    }
    expect(store.touchSession).not.toHaveBeenCalled();
    expect(store.revokeSession).not.toHaveBeenCalled();
  });

  it('sem sessão válida a troca de senha não verifica senha nem altera nada', async () => {
    const { service, store, verify } = setup(real);
    await expect(service.changePassword('segredo', PASSWORD, PASSWORD)).rejects.toMatchObject({ code: 'SESSION_INVALID' });
    expect(verify).not.toHaveBeenCalled();
    expect(store.replacePassword).not.toHaveBeenCalled();
  });

  it('código técnico fora da allowlist é descartado', () => {
    expect(new AuthenticationError('AUTHENTICATION_FAILED', '08006').technicalCode).toBe('08006');
    expect(new AuthenticationError('AUTHENTICATION_FAILED', 'host=db senha').technicalCode).toBeUndefined();
  });
});
