import { describe, expect, it } from 'vitest';
import { DEFECT_CATALOG } from '../../../src/education/defect-catalog.js';
import { EducationalAuthorizationError, hashLabCode, InvalidEducationalConfigError } from '../../../src/education/educational-mode.js';
import { applyConfigChange, defaultWorkspaceConfig, resolveForWorkspace } from '../../../src/education/educational-policy.js';
import { access, CODE_1, COMPATIBLE_CATALOG, FIXTURE_CATALOG, ID_A, ID_B, ID_C, ID_D, VERSION, WS_A, WS_B } from './fixture-catalog.js';

const FACILITATOR_A = access('FACILITATOR');
const FACILITATOR_B = access('FACILITATOR', WS_B);
const CUSTOMER_A = access('CUSTOMER');
const CONFIG_A = defaultWorkspaceConfig(WS_A, FIXTURE_CATALOG);
const CONFIG_B = defaultWorkspaceConfig(WS_B, FIXTURE_CATALOG);

function authorizationError(fn: () => unknown): EducationalAuthorizationError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(EducationalAuthorizationError);
    return error as EducationalAuthorizationError;
  }
  throw new Error('esperava erro de autorização');
}

function rejection(fn: () => unknown): InvalidEducationalConfigError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidEducationalConfigError);
    return error as InvalidEducationalConfigError;
  }
  throw new Error('esperava rejeição');
}

describe('quem altera', () => {
  it('facilitador do próprio workspace muda para CONTROLLED, que começa vazio, numa revisão nova', () => {
    const next = applyConfigChange(FACILITATOR_A, CONFIG_A, { mode: 'CONTROLLED' }, FIXTURE_CATALOG, 'SHARED');
    expect(next).toEqual({ workspaceId: WS_A, revision: 1, catalogVersion: VERSION, mode: 'CONTROLLED', enabledDefectIds: [] });
    expect(CONFIG_A).toMatchObject({ revision: 0, mode: 'STUDENT', preset: { kind: 'NONE' } });
    expect(Object.isFrozen(next)).toBe(true);
  });

  it('cada alteração soma 1, inclusive para a mesma configuração, e grava a versão do catálogo', () => {
    let config = CONFIG_A;
    for (let i = 1; i <= 3; i += 1) {
      config = applyConfigChange(FACILITATOR_A, config, { mode: 'STUDENT', preset: { kind: 'NONE' } }, DEFECT_CATALOG, 'ISOLATED');
      expect(config).toMatchObject({ revision: i, catalogVersion: DEFECT_CATALOG.version });
    }
  });

  it('laboratório escolhido pelo código guarda só o hash', () => {
    const next = applyConfigChange(FACILITATOR_A, CONFIG_A, { mode: 'STUDENT', preset: { kind: 'LAB', code: CODE_1 } }, FIXTURE_CATALOG, 'ISOLATED');
    expect(next).toMatchObject({ preset: { kind: 'LAB', codeHash: hashLabCode(CODE_1) } });
    expect(JSON.stringify(next)).not.toContain(CODE_1);
  });

  const changes: unknown[] = [
    { mode: 'CONTROLLED' }, { mode: 'STUDENT', preset: { kind: 'ALL' } }, { mode: 'STUDENT', preset: { kind: 'LAB', code: CODE_1 } },
    { mode: 'CONTROLLED', enabledDefectIds: [ID_A] }, { mode: 'STUDENT', role: 'FACILITATOR' }, 'inválido', null,
  ];
  it.each(['CUSTOMER', 'STUDENT', 'ADMIN', 'facilitator', ''])('papel %j não altera nem lê, antes de olhar o conteúdo', (role) => {
    for (const change of changes) {
      expect(authorizationError(() => applyConfigChange(access(role), CONFIG_A, change, FIXTURE_CATALOG, 'ISOLATED')).reason).toBe('FACILITATOR_REQUIRED');
    }
    expect(authorizationError(() => resolveForWorkspace(access(role), CONFIG_A, FIXTURE_CATALOG, 'ISOLATED')).reason).toBe('FACILITATOR_REQUIRED');
  });

  it('cliente do próprio workspace não lê nem altera', () => {
    expect(authorizationError(() => resolveForWorkspace(CUSTOMER_A, CONFIG_A, FIXTURE_CATALOG, 'ISOLATED')).reason).toBe('FACILITATOR_REQUIRED');
    expect(authorizationError(() => applyConfigChange(CUSTOMER_A, CONFIG_A, { mode: 'CONTROLLED' }, FIXTURE_CATALOG, 'ISOLATED')).reason).toBe('FACILITATOR_REQUIRED');
  });

  it('facilitador de outro workspace não altera nem lê, mesmo com payload inválido', () => {
    expect(authorizationError(() => applyConfigChange(FACILITATOR_B, CONFIG_A, 'inválido', FIXTURE_CATALOG, 'ISOLATED')).reason).toBe('WORKSPACE_MISMATCH');
    expect(authorizationError(() => resolveForWorkspace(FACILITATOR_A, CONFIG_B, FIXTURE_CATALOG, 'ISOLATED')).reason).toBe('WORKSPACE_MISMATCH');
  });

  it('workspaceId, revisão ou versão no payload são rejeitados', () => {
    for (const extra of [{ workspaceId: WS_B }, { revision: 99 }, { catalogVersion: '2030.01.1' }]) {
      rejection(() => applyConfigChange(FACILITATOR_A, CONFIG_A, { mode: 'CONTROLLED', ...extra }, FIXTURE_CATALOG, 'ISOLATED'));
    }
  });
});

describe('escolha explícita', () => {
  it('STUDENT sem preset é rejeitado; nenhum caminho chega a ALL sem escrevê-lo', () => {
    expect(rejection(() => applyConfigChange(FACILITATOR_A, CONFIG_A, { mode: 'STUDENT' }, FIXTURE_CATALOG, 'ISOLATED')).field).toBe('preset');
  });

  it('ALL escrito é aceito e limitado ao ambiente', () => {
    const next = applyConfigChange(FACILITATOR_A, CONFIG_A, { mode: 'STUDENT', preset: { kind: 'ALL' } }, COMPATIBLE_CATALOG, 'SHARED');
    expect(resolveForWorkspace(FACILITATOR_A, next, COMPATIBLE_CATALOG, 'SHARED').enabledDefectIds).toEqual([ID_A]);
  });
});

describe('ambiente e compatibilidade', () => {
  it.each([[ID_B, 'SHARED'], [ID_C, 'SHARED']] as const)('defeito %s não permitido em %s é rejeitado', (id, env) => {
    rejection(() => applyConfigChange(FACILITATOR_A, CONFIG_A, { mode: 'CONTROLLED', enabledDefectIds: [id] }, FIXTURE_CATALOG, env));
  });

  it('em ambiente isolado o defeito fictício de segurança pode ser habilitado', () => {
    const next = applyConfigChange(FACILITATOR_A, CONFIG_A, { mode: 'CONTROLLED', enabledDefectIds: [ID_B] }, FIXTURE_CATALOG, 'ISOLATED');
    expect(resolveForWorkspace(FACILITATOR_A, next, FIXTURE_CATALOG, 'ISOLATED').enabledDefectIds).toEqual([ID_B]);
  });

  it.each([[[ID_C, ID_D]], [[ID_D, ID_C]], [[ID_A, ID_D, ID_C]]])('par incompatível rejeitado em qualquer ordem: %j', (ids) => {
    const error = rejection(() => applyConfigChange(FACILITATOR_A, CONFIG_A, { mode: 'CONTROLLED', enabledDefectIds: ids }, FIXTURE_CATALOG, 'ISOLATED'));
    expect(error.message).toContain('incompatíveis');
  });

  it('defeitos compatíveis juntos são aceitos', () => {
    const next = applyConfigChange(FACILITATOR_A, CONFIG_A, { mode: 'CONTROLLED', enabledDefectIds: [ID_D, ID_A] }, FIXTURE_CATALOG, 'ISOLATED');
    expect(resolveForWorkspace(FACILITATOR_A, next, FIXTURE_CATALOG, 'ISOLATED').enabledDefectIds).toEqual([ID_A, ID_D]);
  });

  it('ALL com par incompatível permitido no ambiente é rejeitado; onde o par não é permitido, aceito', () => {
    rejection(() => applyConfigChange(FACILITATOR_A, CONFIG_A, { mode: 'STUDENT', preset: { kind: 'ALL' } }, FIXTURE_CATALOG, 'ISOLATED'));
    expect(applyConfigChange(FACILITATOR_A, CONFIG_A, { mode: 'STUDENT', preset: { kind: 'ALL' } }, FIXTURE_CATALOG, 'SHARED').revision).toBe(1);
  });

  it('catálogo vigente vazio: nenhum defeito pode ser habilitado', () => {
    rejection(() => applyConfigChange(FACILITATOR_A, defaultWorkspaceConfig(WS_A, DEFECT_CATALOG), { mode: 'CONTROLLED', enabledDefectIds: [ID_A] }, DEFECT_CATALOG, 'ISOLATED'));
  });
});

describe('leitura', () => {
  it('facilitador lê revisão, versão e o tipo do preset, sem o hash', () => {
    const next = applyConfigChange(FACILITATOR_A, CONFIG_A, { mode: 'STUDENT', preset: { kind: 'LAB', code: CODE_1 } }, FIXTURE_CATALOG, 'ISOLATED');
    const read = resolveForWorkspace(FACILITATOR_A, next, FIXTURE_CATALOG, 'ISOLATED');
    expect(read).toEqual({ workspaceId: WS_A, revision: 1, catalogVersion: VERSION, stale: false, mode: 'STUDENT', preset: { kind: 'LAB' }, enabledDefectIds: [ID_A, ID_B] });
    expect(JSON.stringify(read)).not.toContain(hashLabCode(CODE_1));
    expect(Object.isFrozen(read)).toBe(true);
  });

  it('workspaces diferentes resolvem de forma independente', () => {
    const a = applyConfigChange(FACILITATOR_A, CONFIG_A, { mode: 'CONTROLLED', enabledDefectIds: [ID_A] }, FIXTURE_CATALOG, 'ISOLATED');
    expect(resolveForWorkspace(FACILITATOR_A, a, FIXTURE_CATALOG, 'ISOLATED').enabledDefectIds).toEqual([ID_A]);
    expect(resolveForWorkspace(FACILITATOR_B, CONFIG_B, FIXTURE_CATALOG, 'ISOLATED').enabledDefectIds).toEqual([]);
  });
});
