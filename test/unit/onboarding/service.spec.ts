import { describe, expect, it, vi } from 'vitest';
import {
  type OnboardingDependencies,
  OnboardingError,
  type OnboardingInsert,
  OnboardingService,
  type OnboardingWorkspace,
} from '../../../src/onboarding/application/onboarding.service.js';
import { type OnboardingDraft, OnboardingValidationError } from '../../../src/onboarding/domain/onboarding-request.js';

const WS = '11111111-1111-4111-8111-111111111111';
const DRAFT: OnboardingDraft = {
  alias: 'turma-a', enrollmentCode: null, name: 'Ana Fictícia', cpf: '52998224725', birthDate: '2008-11-27',
  email: 'ana@example.test', phone: '11987654321', password: 'senha de teste bem longa',
};

class Invalid extends Error {}

function setup(options: {
  workspace?: OnboardingWorkspace | null;
  check?: 'ACCEPTED' | 'REQUIRED' | 'INVALID';
  today?: string;
  insert?: OnboardingInsert;
} = {}) {
  const deps = {
    store: {
      findWorkspace: vi.fn().mockResolvedValue(options.workspace === undefined ? { id: WS, status: 'ACTIVE' } : options.workspace),
      insert: vi.fn().mockResolvedValue(options.insert ?? { kind: 'CREATED', requestId: 'req-1' }),
    },
    enrollment: { check: vi.fn().mockResolvedValue(options.check ?? 'ACCEPTED') },
    clock: { today: vi.fn().mockResolvedValue({ date: options.today ?? '2026-11-27', revision: 3 }) },
    attempts: { run: vi.fn(<T>(_subject: string, attempt: () => Promise<T>) => attempt()) },
    invalidAttempt: () => new Invalid(),
    hasher: { hash: vi.fn().mockResolvedValue('hash-argon2') },
  };
  return { deps, service: new OnboardingService(deps as unknown as OnboardingDependencies) };
}

async function code(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(() => undefined, (e: unknown) => e);
  return error instanceof OnboardingError ? error.code : String(error);
}

describe('serviço de onboarding', () => {
  it('grava PENDING com hash, data simulada e revisão; a senha só vai ao hash', async () => {
    const { deps, service } = setup();
    expect(await service.submit(DRAFT)).toEqual({ requestId: 'req-1', status: 'PENDING' });
    expect(deps.hasher.hash).toHaveBeenCalledWith(DRAFT.password);
    const [stored] = deps.store.insert.mock.calls[0] as [Record<string, unknown>];
    expect(stored).toEqual({
      workspaceId: WS, name: DRAFT.name, cpf: DRAFT.cpf, birthDate: DRAFT.birthDate, email: DRAFT.email, phone: DRAFT.phone,
      passwordHash: 'hash-argon2', businessDate: '2026-11-27', clockRevision: 3,
    });
    expect(JSON.stringify(stored)).not.toContain(DRAFT.password);
  });

  it('idade pela data simulada: 18 no dia é aceito, um dia antes é recusado sem hash nem gravação', async () => {
    expect(await setup({ today: '2026-11-27' }).service.submit(DRAFT)).toMatchObject({ status: 'PENDING' });
    const young = setup({ today: '2026-11-26' });
    expect(await code(young.service.submit(DRAFT))).toBe('UNDERAGE');
    expect(young.deps.hasher.hash).not.toHaveBeenCalled();
    expect(young.deps.store.insert).not.toHaveBeenCalled();
  });

  it('nascimento posterior à data simulada é campo inválido', async () => {
    const { service } = setup({ today: '2026-11-27' });
    await expect(service.submit({ ...DRAFT, birthDate: '2026-11-28' })).rejects.toBeInstanceOf(OnboardingValidationError);
  });

  it.each<[string, Parameters<typeof setup>[0], string]>([
    ['alias inexistente', { workspace: null }, 'WORKSPACE_NOT_FOUND'],
    ['workspace arquivado', { workspace: { id: WS, status: 'ARCHIVED' } }, 'WORKSPACE_ARCHIVED'],
    ['código exigido', { check: 'REQUIRED' }, 'ENROLLMENT_CODE_REQUIRED'],
    ['código inválido', { check: 'INVALID' }, 'ENROLLMENT_CODE_INVALID'],
    ['duplicado', { insert: { kind: 'DUPLICATE', fields: ['cpf'] } }, 'DUPLICATE'],
    ['arquivado na gravação', { insert: { kind: 'ARCHIVED' } }, 'WORKSPACE_ARCHIVED'],
  ])('%s', async (_label, options, expected) => {
    expect(await code(setup(options).service.submit(DRAFT))).toBe(expected);
  });

  it('só o código inválido chega ao limitador como falha; o pedido sem código não conta nem zera', async () => {
    const invalid = setup({ check: 'INVALID' });
    const seen: unknown[] = [];
    invalid.deps.attempts.run.mockImplementation(async <T>(_s: string, attempt: () => Promise<T>) => {
      try {
        return await attempt();
      } catch (e) {
        seen.push(e);
        throw e;
      }
    });
    await invalid.service.submit(DRAFT).catch(() => undefined);
    expect(seen[0]).toBeInstanceOf(Invalid);
    expect(invalid.deps.attempts.run).toHaveBeenCalledWith(JSON.stringify(['enrollment', 'turma-a', 'ana@example.test']), expect.any(Function));
    const required = setup({ check: 'REQUIRED' });
    const outcomes: string[] = [];
    required.deps.attempts.run.mockImplementation(async <T>(_s: string, attempt: () => Promise<T>) => {
      try {
        const value = await attempt();
        outcomes.push('success');
        return value;
      } catch (e) {
        outcomes.push(e instanceof Invalid ? 'counted' : 'neutral');
        throw e;
      }
    });
    await required.service.submit(DRAFT).catch(() => undefined);
    expect(outcomes).toEqual(['neutral']);
  });

  it('duplicado leva os campos', async () => {
    const error = await setup({ insert: { kind: 'DUPLICATE', fields: ['cpf', 'email'] } }).service.submit(DRAFT).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'DUPLICATE', fields: ['cpf', 'email'] });
  });
});
