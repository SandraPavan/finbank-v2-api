import { describe, expect, it } from 'vitest';
import { DEFECT_CATALOG } from '../../../src/education/defect-catalog.js';
import {
  type Actor,
  EducationalAuthorizationError,
  hashLabCode,
  InvalidEducationalConfigError,
  type WorkspaceEducationalConfig,
} from '../../../src/education/educational-mode.js';
import {
  applyConfigChange,
  defaultWorkspaceConfig,
  resolveForWorkspace,
} from '../../../src/education/educational-policy.js';
import { CODE_1, FIXTURE_CATALOG, ID_A, ID_B, ID_C } from './fixture-catalog.js';

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

  it('facilitador escolhe preset de laboratório pelo código; somente o hash é armazenado', () => {
    const next = applyConfigChange(
      FACILITATOR_A,
      CONFIG_A,
      { mode: 'STUDENT', preset: { kind: 'LAB', code: CODE_1 } },
      FIXTURE_CATALOG,
      'ISOLATED',
    );
    expect(next).toEqual({ workspaceId: 'ws-a', mode: 'STUDENT', preset: { kind: 'LAB', codeHash: hashLabCode(CODE_1) } });
  });

  it.each([
    { mode: 'CONTROLLED' },
    { mode: 'STUDENT' },
    { mode: 'STUDENT', preset: { kind: 'LAB', code: CODE_1 } },
    { mode: 'CONTROLLED', enabledDefectIds: [ID_A] },
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
        { mode: 'CONTROLLED', enabledDefectIds: [ID_B] },
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
        { mode: 'CONTROLLED', enabledDefectIds: [ID_C] },
        FIXTURE_CATALOG,
        'SHARED',
      ),
    ).toThrow(InvalidEducationalConfigError);
  });

  it('em ambiente isolado o defeito fictício que afeta segurança pode ser habilitado pelo facilitador', () => {
    const next = applyConfigChange(
      FACILITATOR_A,
      CONFIG_A,
      { mode: 'CONTROLLED', enabledDefectIds: [ID_B] },
      FIXTURE_CATALOG,
      'ISOLATED',
    );
    expect(next).toEqual({ workspaceId: 'ws-a', mode: 'CONTROLLED', enabledDefectIds: [ID_B] });
  });

  it('catálogo vigente vazio: nenhum defeito pode ser habilitado em nenhum ambiente', () => {
    for (const env of ['ISOLATED', 'SHARED'] as const) {
      expect(() =>
        applyConfigChange(FACILITATOR_A, CONFIG_A, { mode: 'CONTROLLED', enabledDefectIds: [ID_A] }, DEFECT_CATALOG, env),
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
      { mode: 'CONTROLLED', enabledDefectIds: [ID_A] },
      FIXTURE_CATALOG,
      'SHARED',
    );
    expect(resolveForWorkspace(FACILITATOR_A, CONFIG_A, FIXTURE_CATALOG, 'SHARED')).toMatchObject({
      mode: 'STUDENT',
      enabledDefectIds: [ID_A],
    });
    expect(resolveForWorkspace(FACILITATOR_B, controlledB, FIXTURE_CATALOG, 'SHARED')).toMatchObject({
      mode: 'CONTROLLED',
      preset: null,
      enabledDefectIds: [ID_A],
    });
    expect(CONFIG_A.mode).toBe('STUDENT');
  });
});

describe('leitura de preset de laboratório', () => {
  it('a configuração resolvida indica LAB sem expor o código nem o hash', () => {
    const lab = applyConfigChange(
      FACILITATOR_A,
      CONFIG_A,
      { mode: 'STUDENT', preset: { kind: 'LAB', code: CODE_1 } },
      FIXTURE_CATALOG,
      'ISOLATED',
    );
    const resolved = resolveForWorkspace(STUDENT_A, lab, FIXTURE_CATALOG, 'ISOLATED');
    expect(resolved).toEqual({ workspaceId: 'ws-a', mode: 'STUDENT', preset: { kind: 'LAB' }, enabledDefectIds: [ID_A, ID_B] });
    const serialized = JSON.stringify(resolved);
    expect(serialized).not.toContain(CODE_1);
    expect(serialized).not.toContain(hashLabCode(CODE_1));
  });
});
