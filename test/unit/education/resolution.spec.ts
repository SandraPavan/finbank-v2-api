import { describe, expect, it } from 'vitest';
import { DEFECT_CATALOG } from '../../../src/education/defect-catalog.js';
import {
  ENVIRONMENT_KINDS,
  type EnvironmentKind,
  hashLabCode,
  type WorkspaceEducationalConfig,
} from '../../../src/education/educational-mode.js';
import {
  defaultWorkspaceConfig,
  isDefectAllowed,
  resolveEnabledDefects,
} from '../../../src/education/educational-policy.js';
import { CODE_1, CODE_2, FIXTURE_CATALOG, ID_A, ID_B, ID_C } from './fixture-catalog.js';

const WS = 'ws-a';

const CONFIGS: Record<string, WorkspaceEducationalConfig> = {
  'STUDENT/ALL': { workspaceId: WS, mode: 'STUDENT', preset: { kind: 'ALL' } },
  'STUDENT/LAB-1': { workspaceId: WS, mode: 'STUDENT', preset: { kind: 'LAB', codeHash: hashLabCode(CODE_1) } },
  'STUDENT/LAB-2': { workspaceId: WS, mode: 'STUDENT', preset: { kind: 'LAB', codeHash: hashLabCode(CODE_2) } },
  'CONTROLLED/vazio': { workspaceId: WS, mode: 'CONTROLLED', enabledDefectIds: [] },
  'CONTROLLED/A': { workspaceId: WS, mode: 'CONTROLLED', enabledDefectIds: [ID_A] },
  'CONTROLLED/B (segurança)': { workspaceId: WS, mode: 'CONTROLLED', enabledDefectIds: [ID_B] },
};

describe('defaults', () => {
  it('workspace sem configuração começa em STUDENT com preset ALL', () => {
    expect(defaultWorkspaceConfig(WS)).toEqual({ workspaceId: WS, mode: 'STUDENT', preset: { kind: 'ALL' } });
  });
});

describe('catálogo vigente vazio: zero defeitos executáveis', () => {
  const matrix = Object.keys(CONFIGS).flatMap((name) => ENVIRONMENT_KINDS.map((env) => [name, env] as const));

  it.each(matrix)('%s em %s → []', (name, env) => {
    expect(resolveEnabledDefects(CONFIGS[name]!, DEFECT_CATALOG, env)).toEqual([]);
  });
});

describe('matriz modo × preset × ambiente (catálogo fictício)', () => {
  const expected: Record<string, Record<EnvironmentKind, string[]>> = {
    'STUDENT/ALL': {
      ISOLATED: [ID_A, ID_B, ID_C],
      SHARED: [ID_A],
    },
    'STUDENT/LAB-1': { ISOLATED: [ID_A, ID_B], SHARED: [ID_A] },
    'STUDENT/LAB-2': { ISOLATED: [ID_C], SHARED: [] },
    'CONTROLLED/vazio': { ISOLATED: [], SHARED: [] },
    'CONTROLLED/A': { ISOLATED: [ID_A], SHARED: [ID_A] },
    'CONTROLLED/B (segurança)': { ISOLATED: [ID_B], SHARED: [] },
  };
  const matrix = Object.keys(expected).flatMap((name) => ENVIRONMENT_KINDS.map((env) => [name, env] as const));

  it.each(matrix)('%s em %s', (name, env) => {
    expect(resolveEnabledDefects(CONFIGS[name]!, FIXTURE_CATALOG, env)).toEqual(expected[name]![env]);
  });

  it('ALL inclui automaticamente um defeito novo permitido, sem mudar a configuração', () => {
    const grown = {
      defects: [...FIXTURE_CATALOG.defects, { id: 'd-0123456789abcdef', affectsSecurity: false, allowedEnvironments: ['SHARED'] as const }],
      labPresets: FIXTURE_CATALOG.labPresets,
    };
    expect(resolveEnabledDefects(CONFIGS['STUDENT/ALL']!, grown, 'SHARED')).toEqual([ID_A, 'd-0123456789abcdef']);
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
    expect(isDefectAllowed({ id: 'x', affectsSecurity, allowedEnvironments }, env)).toBe(allowed);
  });
});
