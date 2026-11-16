import { describe, expect, it } from 'vitest';
import { DEFECT_CATALOG } from '../../../src/education/defect-catalog.js';
import {
  type Actor,
  EducationalAuthorizationError,
  InvalidEducationalConfigError,
  type WorkspaceEducationalConfig,
} from '../../../src/education/educational-mode.js';
import {
  applyConfigChange,
  defaultWorkspaceConfig,
  resolveForWorkspace,
} from '../../../src/education/educational-policy.js';
import { FIXTURE_CATALOG } from './fixture-catalog.js';

const FACILITATOR_A: Actor = { role: 'FACILITATOR', workspaceId: 'ws-a' };
const FACILITATOR_B: Actor = { role: 'FACILITATOR', workspaceId: 'ws-b' };
const STUDENT_A: Actor = { role: 'STUDENT', workspaceId: 'ws-a' };
const CONFIG_A = defaultWorkspaceConfig('ws-a');
const CONFIG_B = defaultWorkspaceConfig('ws-b');

function authorizationError(fn: () => unknown): EducationalAuthorizationError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(EducationalAuthorizationError);
    return error as EducationalAuthorizationError;
  }
  throw new Error('esperava erro de autorização');
}

describe('alteração de configuração — papel e workspace', () => {
  it('facilitador do próprio workspace muda para CONTROLLED, que começa sem defeitos', () => {
    const next = applyConfigChange(FACILITATOR_A, CONFIG_A, { mode: 'CONTROLLED' }, DEFECT_CATALOG, 'SHARED');
    expect(next).toEqual({ workspaceId: 'ws-a', mode: 'CONTROLLED', enabledDefectIds: [] });
    expect(CONFIG_A).toEqual({ workspaceId: 'ws-a', mode: 'STUDENT', preset: { kind: 'ALL' } });
    expect(Object.isFrozen(next)).toBe(true);
  });

  it('facilitador escolhe preset de laboratório existente', () => {
    const next = applyConfigChange(
      FACILITATOR_A,
      CONFIG_A,
      { mode: 'STUDENT', preset: { kind: 'LAB', labId: 'lab-fixture-a' } },
      FIXTURE_CATALOG,
      'ISOLATED',
    );
    expect(next).toEqual({ workspaceId: 'ws-a', mode: 'STUDENT', preset: { kind: 'LAB', labId: 'lab-fixture-a' } });
  });

  it.each([
    { mode: 'CONTROLLED' },
    { mode: 'STUDENT' },
    { mode: 'STUDENT', preset: { kind: 'LAB', labId: 'lab-fixture-a' } },
    { mode: 'CONTROLLED', enabledDefectIds: ['fixture-functional'] },
    { mode: 'STUDENT', role: 'FACILITATOR' },
  ])('estudante não altera a configuração (%j)', (change) => {
    const error = authorizationError(() => applyConfigChange(STUDENT_A, CONFIG_A, change, FIXTURE_CATALOG, 'ISOLATED'));
    expect(error.reason).toBe('FACILITATOR_REQUIRED');
  });

  it('autorização é verificada antes do conteúdo: estudante com payload inválido recebe erro de autorização', () => {
    expect(authorizationError(() => applyConfigChange(STUDENT_A, CONFIG_A, 'lixo', FIXTURE_CATALOG, 'SHARED')).reason).toBe(
      'FACILITATOR_REQUIRED',
    );
  });

  it('papel desconhecido no contexto do ator é tratado como sem privilégio', () => {
    const forged = { role: 'ADMIN', workspaceId: 'ws-a' } as unknown as Actor;
    expect(authorizationError(() => applyConfigChange(forged, CONFIG_A, { mode: 'CONTROLLED' }, DEFECT_CATALOG, 'SHARED')).reason).toBe(
      'FACILITATOR_REQUIRED',
    );
  });

  it('facilitador de outro workspace não altera a configuração', () => {
    const error = authorizationError(() =>
      applyConfigChange(FACILITATOR_B, CONFIG_A, { mode: 'CONTROLLED' }, DEFECT_CATALOG, 'SHARED'),
    );
    expect(error.reason).toBe('WORKSPACE_MISMATCH');
  });

  it('workspaceId no payload não redireciona a alteração', () => {
    expect(() =>
      applyConfigChange(FACILITATOR_A, CONFIG_A, { mode: 'CONTROLLED', workspaceId: 'ws-b' }, DEFECT_CATALOG, 'SHARED'),
    ).toThrow(InvalidEducationalConfigError);
  });
});

describe('alteração de configuração — política de ambiente', () => {
  it('facilitador não habilita defeito de segurança em ambiente compartilhado', () => {
    expect(() =>
      applyConfigChange(
        FACILITATOR_A,
        CONFIG_A,
        { mode: 'CONTROLLED', enabledDefectIds: ['fixture-security'] },
        FIXTURE_CATALOG,
        'SHARED',
      ),
    ).toThrow(/não permitido neste ambiente/);
  });

  it('facilitador não habilita defeito restrito a ISOLATED em SHARED', () => {
    expect(() =>
      applyConfigChange(
        FACILITATOR_A,
        CONFIG_A,
        { mode: 'CONTROLLED', enabledDefectIds: ['fixture-isolated-only'] },
        FIXTURE_CATALOG,
        'SHARED',
      ),
    ).toThrow(InvalidEducationalConfigError);
  });

  it('em ambiente isolado o defeito de segurança fictício pode ser habilitado pelo facilitador', () => {
    const next = applyConfigChange(
      FACILITATOR_A,
      CONFIG_A,
      { mode: 'CONTROLLED', enabledDefectIds: ['fixture-security'] },
      FIXTURE_CATALOG,
      'ISOLATED',
    );
    expect(next).toEqual({ workspaceId: 'ws-a', mode: 'CONTROLLED', enabledDefectIds: ['fixture-security'] });
  });

  it('catálogo vigente vazio: nenhum defeito pode ser habilitado em nenhum ambiente', () => {
    for (const env of ['ISOLATED', 'SHARED'] as const) {
      expect(() =>
        applyConfigChange(FACILITATOR_A, CONFIG_A, { mode: 'CONTROLLED', enabledDefectIds: ['fixture-functional'] }, DEFECT_CATALOG, env),
      ).toThrow(InvalidEducationalConfigError);
    }
  });
});

describe('leitura isolada por workspace', () => {
  it.each([STUDENT_A, FACILITATOR_A])('%j lê a configuração resolvida do próprio workspace', (actor) => {
    expect(resolveForWorkspace(actor, CONFIG_A, DEFECT_CATALOG, 'SHARED')).toEqual({
      workspaceId: 'ws-a',
      mode: 'STUDENT',
      preset: { kind: 'ALL' },
      enabledDefectIds: [],
    });
  });

  it.each([STUDENT_A, FACILITATOR_A])('%j não lê a configuração de outro workspace', (actor) => {
    expect(authorizationError(() => resolveForWorkspace(actor, CONFIG_B, DEFECT_CATALOG, 'SHARED')).reason).toBe(
      'WORKSPACE_MISMATCH',
    );
  });

  it('configurações de workspaces diferentes resolvem de forma independente', () => {
    const controlledB: WorkspaceEducationalConfig = applyConfigChange(
      FACILITATOR_B,
      CONFIG_B,
      { mode: 'CONTROLLED', enabledDefectIds: ['fixture-functional'] },
      FIXTURE_CATALOG,
      'SHARED',
    );
    expect(resolveForWorkspace(FACILITATOR_A, CONFIG_A, FIXTURE_CATALOG, 'SHARED')).toMatchObject({
      mode: 'STUDENT',
      enabledDefectIds: ['fixture-functional'],
    });
    expect(resolveForWorkspace(FACILITATOR_B, controlledB, FIXTURE_CATALOG, 'SHARED')).toMatchObject({
      mode: 'CONTROLLED',
      preset: null,
      enabledDefectIds: ['fixture-functional'],
    });
    expect(CONFIG_A.mode).toBe('STUDENT');
  });
});
