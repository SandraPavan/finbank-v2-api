import { describe, expect, it } from 'vitest';
import { DEFECT_CATALOG } from '../../../src/education/defect-catalog.js';
import { ENVIRONMENT_KINDS, type EnvironmentKind, hashLabCode, type WorkspaceEducationalConfig } from '../../../src/education/educational-mode.js';
import { defaultWorkspaceConfig, isDefectAllowed, isDefectActive, resolve, resolveEnabledDefects } from '../../../src/education/educational-policy.js';
import { CODE_1, CODE_2, COMPATIBLE_CATALOG, FIXTURE_CATALOG, ID_A, ID_B, ID_C, ID_D, OP_X, OP_Y, VERSION, WS_A } from './fixture-catalog.js';

const base = { workspaceId: WS_A, revision: 3, catalogVersion: VERSION };
const CONFIGS: Record<string, WorkspaceEducationalConfig> = {
  'STUDENT/NONE': { ...base, mode: 'STUDENT', preset: { kind: 'NONE' } },
  'STUDENT/ALL': { ...base, mode: 'STUDENT', preset: { kind: 'ALL' } },
  'STUDENT/LAB-1': { ...base, mode: 'STUDENT', preset: { kind: 'LAB', codeHash: hashLabCode(CODE_1) } },
  'STUDENT/LAB-2': { ...base, mode: 'STUDENT', preset: { kind: 'LAB', codeHash: hashLabCode(CODE_2) } },
  'CONTROLLED/vazio': { ...base, mode: 'CONTROLLED', enabledDefectIds: [] },
  'CONTROLLED/A': { ...base, mode: 'CONTROLLED', enabledDefectIds: [ID_A] },
  'CONTROLLED/B (segurança)': { ...base, mode: 'CONTROLLED', enabledDefectIds: [ID_B] },
};

describe('padrão sem defeitos', () => {
  it.each([DEFECT_CATALOG, FIXTURE_CATALOG])('workspace sem configuração: STUDENT/NONE, revisão 0, nenhum defeito', (catalog) => {
    const config = defaultWorkspaceConfig(WS_A, catalog);
    expect(config).toEqual({ workspaceId: WS_A, revision: 0, catalogVersion: catalog.version, mode: 'STUDENT', preset: { kind: 'NONE' } });
    for (const env of ENVIRONMENT_KINDS) {
      expect(resolveEnabledDefects(config, catalog, env)).toEqual([]);
    }
  });
});

describe('catálogo vigente vazio: zero defeitos executáveis', () => {
  const matrix = Object.keys(CONFIGS).flatMap((name) => ENVIRONMENT_KINDS.map((env) => [name, env] as const));
  it.each(matrix)('%s em %s → []', (name, env) => {
    const config = { ...CONFIGS[name]!, catalogVersion: DEFECT_CATALOG.version } as WorkspaceEducationalConfig;
    expect(resolveEnabledDefects(config, DEFECT_CATALOG, env)).toEqual([]);
  });
});

describe('matriz modo × preset × ambiente (catálogo fictício)', () => {
  const expected: Record<string, Record<EnvironmentKind, string[]>> = {
    'STUDENT/NONE': { ISOLATED: [], SHARED: [] },
    'STUDENT/ALL': { ISOLATED: [ID_A, ID_B, ID_C, ID_D], SHARED: [ID_A] },
    'STUDENT/LAB-1': { ISOLATED: [ID_A, ID_B], SHARED: [ID_A] },
    'STUDENT/LAB-2': { ISOLATED: [ID_C], SHARED: [] },
    'CONTROLLED/vazio': { ISOLATED: [], SHARED: [] },
    'CONTROLLED/A': { ISOLATED: [ID_A], SHARED: [ID_A] },
    'CONTROLLED/B (segurança)': { ISOLATED: [ID_B], SHARED: [] },
  };
  const matrix = Object.keys(expected).flatMap((name) => ENVIRONMENT_KINDS.map((env) => [name, env] as const));

  it.each(matrix)('%s em %s', (name, env) => {
    const resolved = resolveEnabledDefects(CONFIGS[name]!, FIXTURE_CATALOG, env);
    expect(resolved).toEqual(expected[name]![env]);
    expect(Object.isFrozen(resolved)).toBe(true);
  });

  it('a ordem dos itens não muda o resultado: sempre a do catálogo', () => {
    const reversed = { ...base, mode: 'CONTROLLED' as const, enabledDefectIds: [ID_C, ID_A] };
    const straight = { ...reversed, enabledDefectIds: [ID_A, ID_C] };
    expect(resolveEnabledDefects(reversed, FIXTURE_CATALOG, 'ISOLATED')).toEqual([ID_A, ID_C]);
    expect(resolveEnabledDefects(straight, FIXTURE_CATALOG, 'ISOLATED')).toEqual([ID_A, ID_C]);
  });

  it('revisão criada com outra versão do catálogo não ativa nada', () => {
    const old = { ...CONFIGS['CONTROLLED/A']!, catalogVersion: '2025.12.1' } as WorkspaceEducationalConfig;
    expect(resolveEnabledDefects(old, FIXTURE_CATALOG, 'ISOLATED')).toEqual([]);
    expect(resolve(old, FIXTURE_CATALOG, 'ISOLATED')).toMatchObject({ stale: true, enabledDefectIds: [], revision: 3 });
    expect(resolve(CONFIGS['CONTROLLED/A']!, FIXTURE_CATALOG, 'ISOLATED')).toMatchObject({ stale: false, catalogVersion: VERSION });
  });
});

describe('defeito por operação', () => {
  const resolved = resolve(CONFIGS['STUDENT/LAB-1']!, FIXTURE_CATALOG, 'ISOLATED');

  it.each([
    [ID_A, OP_X, true], [ID_A, OP_Y, false], [ID_B, OP_Y, true], [ID_B, OP_X, false], [ID_C, OP_X, false], [ID_D, OP_Y, false],
  ] as const)('%s em %s → %s', (id, op, active) => {
    expect(isDefectActive(resolved, op, id, FIXTURE_CATALOG)).toBe(active);
  });

  it('o mesmo defeito, bloqueado no ambiente, nunca está ativo', () => {
    expect(isDefectActive(resolve(CONFIGS['STUDENT/LAB-1']!, FIXTURE_CATALOG, 'SHARED'), OP_Y, ID_B, FIXTURE_CATALOG)).toBe(false);
  });

  it.each(['OPERACAO_INEXISTENTE', 'fictitious_operation_x', '', 1, undefined])('operação desconhecida é erro: %j', (op) => {
    expect(() => isDefectActive(resolved, op, ID_A, FIXTURE_CATALOG)).toThrow(/operação deve ser uma operação do catálogo/);
  });

  it('resolvida com outra versão do catálogo nunca ativa', () => {
    expect(isDefectActive({ ...resolved, catalogVersion: '2025.12.1' }, OP_X, ID_A, FIXTURE_CATALOG)).toBe(false);
  });

  it('catálogo vigente: nenhuma operação existe, então nada pode ser consultado', () => {
    const current = resolve(defaultWorkspaceConfig(WS_A, DEFECT_CATALOG), DEFECT_CATALOG, 'ISOLATED');
    expect(DEFECT_CATALOG.operations).toEqual([]);
    expect(() => isDefectActive(current, OP_X, ID_A, DEFECT_CATALOG)).toThrow();
  });

  it('com catálogo compatível o resultado é estável entre chamadas', () => {
    const config = { ...CONFIGS['STUDENT/ALL']!, catalogVersion: COMPATIBLE_CATALOG.version } as WorkspaceEducationalConfig;
    expect(resolve(config, COMPATIBLE_CATALOG, 'ISOLATED')).toEqual(resolve(config, COMPATIBLE_CATALOG, 'ISOLATED'));
  });
});

describe('política de segurança', () => {
  it.each([
    [false, ['ISOLATED', 'SHARED'], 'ISOLATED', true],
    [false, ['ISOLATED', 'SHARED'], 'SHARED', true],
    [true, ['ISOLATED', 'SHARED'], 'ISOLATED', true],
    [true, ['ISOLATED', 'SHARED'], 'SHARED', false],
    [false, ['ISOLATED'], 'SHARED', false],
    [true, ['SHARED'], 'SHARED', false],
  ] as const)('affectsSecurity=%s, permitidos=%j, ambiente=%s → %s', (affectsSecurity, allowedEnvironments, env, allowed) => {
    expect(isDefectAllowed({ affectsSecurity, allowedEnvironments }, env)).toBe(allowed);
  });
});
