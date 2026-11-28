import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceAccess } from '../../../src/identity/domain/workspace-access.js';
import {
  type DecisionResult,
  OnboardingAdministrationError,
  OnboardingAdministrationService,
  type OnboardingAdministrationStore,
  parsePolicyChange,
} from '../../../src/onboarding/application/onboarding-administration.service.js';
import { type OnboardingDependencies, OnboardingError, OnboardingService } from '../../../src/onboarding/application/onboarding.service.js';
import { generateStatusCredential, hashStatusCredential } from '../../../src/onboarding/domain/status-credential.js';

const WS = '11111111-1111-4111-8111-111111111111';
const REQUEST = '33333333-3333-4333-8333-333333333333';
const access: WorkspaceAccess = { identityId: '22222222-2222-4222-8222-222222222222', workspaceId: WS, role: 'FACILITATOR' };

describe('credencial de consulta', () => {
  it('20 símbolos Crockford em cinco grupos, sem repetir; hash igual para as formas aceitas', () => {
    const credentials = Array.from({ length: 1_000 }, generateStatusCredential);
    credentials.forEach((c) => expect(c).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){4}$/));
    expect(new Set(credentials).size).toBe(credentials.length);
    const [first = ''] = credentials;
    expect(hashStatusCredential(first)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashStatusCredential(first.toLowerCase().replace(/-/g, ''))).toBe(hashStatusCredential(first));
    for (const raw of ['', 'curta', 'ILOU-ILOU-ILOU-ILOU-ILOU', `${first}-X`]) {
      expect(hashStatusCredential(raw), raw).toBeNull();
    }
  });
});

function onboarding(findStatus: OnboardingDependencies['store']['findStatus']) {
  class Invalid extends Error {}
  const attempts = { run: vi.fn(<T>(_s: string, attempt: () => Promise<T>) => attempt()) };
  const deps = {
    store: { findWorkspace: vi.fn(), insert: vi.fn(), findStatus: vi.fn(findStatus) },
    enrollment: { check: vi.fn() },
    clock: { today: vi.fn() },
    attempts,
    invalidAttempt: () => new Invalid(),
    hasher: { hash: vi.fn() },
  };
  return { deps, service: new OnboardingService(deps as unknown as OnboardingDependencies), Invalid };
}

describe('consulta do estado', () => {
  const credential = generateStatusCredential();

  it('credencial certa devolve só identificador e estado', async () => {
    const { service, deps } = onboarding(() => Promise.resolve('PENDING'));
    expect(await service.status(REQUEST, credential)).toEqual({ requestId: REQUEST, status: 'PENDING' });
    expect(deps.store.findStatus).toHaveBeenCalledWith(REQUEST, hashStatusCredential(credential));
    expect(deps.attempts.run).toHaveBeenCalledWith(JSON.stringify(['onboarding-status', REQUEST]), expect.any(Function));
  });

  it('credencial que não confere conta como tentativa e vira o mesmo NOT_FOUND', async () => {
    const { service, deps, Invalid } = onboarding(() => Promise.resolve(null));
    const seen: unknown[] = [];
    deps.attempts.run.mockImplementation(async <T>(_s: string, attempt: () => Promise<T>) => {
      try {
        return await attempt();
      } catch (e) {
        seen.push(e);
        throw e;
      }
    });
    await expect(service.status(REQUEST, credential)).rejects.toMatchObject({ code: 'STATUS_NOT_FOUND' });
    expect(seen[0]).toBeInstanceOf(Invalid);
  });

  it.each([['identificador malformado', 'x', credential], ['credencial malformada', REQUEST, 'curta']])('%s: NOT_FOUND sem consultar', async (_l, id, raw) => {
    const { service, deps } = onboarding(() => Promise.resolve('PENDING'));
    const error = await service.status(id, raw).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OnboardingError);
    expect(error).toMatchObject({ code: 'STATUS_NOT_FOUND' });
    expect(deps.store.findStatus).not.toHaveBeenCalled();
    expect(deps.attempts.run).not.toHaveBeenCalled();
  });
});

function administration(overrides: Partial<Record<keyof OnboardingAdministrationStore, ReturnType<typeof vi.fn>>> = {}) {
  const store = {
    policy: vi.fn().mockResolvedValue({ mode: 'AUTOMATIC', revision: 0 }),
    publishPolicy: vi.fn().mockResolvedValue('PUBLISHED'),
    list: vi.fn().mockResolvedValue([]),
    decide: vi.fn().mockResolvedValue({ kind: 'DECIDED', status: 'APPROVED' }),
    ...overrides,
  };
  return { store, service: new OnboardingAdministrationService(store as unknown as OnboardingAdministrationStore) };
}

async function code(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(() => undefined, (e: unknown) => e);
  return error instanceof OnboardingAdministrationError ? error.code : String(error);
}

describe('política de aprovação', () => {
  it('troca de modo grava a revisão seguinte; o mesmo modo não grava', async () => {
    const { service, store } = administration();
    expect(await service.changePolicy(access, { baseRevision: 0, mode: 'MANUAL' }, 'corr-0001')).toEqual({ workspaceId: WS, mode: 'MANUAL', revision: 1 });
    expect(store.publishPolicy).toHaveBeenCalledWith(access, 1, 'MANUAL', 'corr-0001');
    store.publishPolicy.mockClear();
    expect(await service.changePolicy(access, { baseRevision: 0, mode: 'AUTOMATIC' }, 'corr-0001')).toEqual({ workspaceId: WS, mode: 'AUTOMATIC', revision: 0 });
    expect(store.publishPolicy).not.toHaveBeenCalled();
  });

  it.each([
    ['base desatualizada', { baseRevision: 3, mode: 'MANUAL' }, 'PUBLISHED', 'POLICY_CONFLICT'],
    ['revisão concorrente', { baseRevision: 0, mode: 'MANUAL' }, 'CONFLICT', 'POLICY_CONFLICT'],
    ['vínculo perdido', { baseRevision: 0, mode: 'MANUAL' }, 'DENIED', 'ACCESS_LOST'],
    ['workspace arquivado', { baseRevision: 0, mode: 'MANUAL' }, 'ARCHIVED', 'WORKSPACE_ARCHIVED'],
  ])('%s', async (_l, body, publish, expected) => {
    const { service } = administration({ publishPolicy: vi.fn().mockResolvedValue(publish) });
    expect(await code(service.changePolicy(access, body, 'corr-0001'))).toBe(expected);
  });

  it.each<[string, unknown]>([
    ['nulo', null], ['modo desconhecido', { baseRevision: 0, mode: 'AUTO' }], ['base texto', { baseRevision: '0', mode: 'MANUAL' }],
    ['base negativa', { baseRevision: -1, mode: 'MANUAL' }], ['campo extra', { baseRevision: 0, mode: 'MANUAL', revision: 1 }], ['lista', []],
  ])('corpo %s é recusado', (_l, raw) => {
    expect(() => parsePolicyChange(raw)).toThrow(OnboardingAdministrationError);
  });
});

describe('lista e decisão', () => {
  it('lista pagina com uma linha a mais e filtra só estados válidos', async () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({ requestId: `r${i}` }));
    const { service, store } = administration({ list: vi.fn().mockResolvedValue(rows) });
    expect(await service.list(access, 'PENDING', { limit: 2, offset: 4 })).toEqual({ items: rows.slice(0, 2), nextOffset: 6 });
    expect(store.list).toHaveBeenCalledWith(WS, 'PENDING', { limit: 3, offset: 4 });
    expect(await code(service.list(access, 'pending', { limit: 2, offset: 0 }))).toBe('INVALID_REQUEST');
    await service.list(access, undefined, { limit: 2, offset: 0 });
    expect(store.list).toHaveBeenLastCalledWith(WS, null, { limit: 3, offset: 0 });
  });

  it.each<[DecisionResult, string]>([
    [{ kind: 'NOT_FOUND' }, 'REQUEST_NOT_FOUND'], [{ kind: 'DENIED' }, 'ACCESS_LOST'], [{ kind: 'ARCHIVED' }, 'WORKSPACE_ARCHIVED'],
    [{ kind: 'ALREADY_DECIDED' }, 'ALREADY_DECIDED'], [{ kind: 'DUPLICATE' }, 'DUPLICATE'],
  ])('resultado %j vira erro tipado', async (result, expected) => {
    const { service } = administration({ decide: vi.fn().mockResolvedValue(result) });
    expect(await code(service.decide(access, REQUEST, 'APPROVED', 'corr-0001'))).toBe(expected);
  });

  it('decidida ou repetida devolve o estado; identificador malformado é NOT_FOUND sem consultar', async () => {
    const { service, store } = administration({ decide: vi.fn().mockResolvedValue({ kind: 'UNCHANGED', status: 'REJECTED' }) });
    expect(await service.decide(access, REQUEST, 'REJECTED', 'corr-0001')).toEqual({ workspaceId: WS, requestId: REQUEST, status: 'REJECTED' });
    expect(await code(service.decide(access, 'x', 'REJECTED', 'corr-0001'))).toBe('REQUEST_NOT_FOUND');
    expect(store.decide).toHaveBeenCalledTimes(1);
  });
});
