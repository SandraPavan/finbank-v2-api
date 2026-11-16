import { describe, expect, it } from 'vitest';
import { DEFECT_CATALOG } from '../../../src/education/defect-catalog.js';
import {
  ENVIRONMENT_KINDS,
  type EnvironmentKind,
  type WorkspaceEducationalConfig,
} from '../../../src/education/educational-mode.js';
import {
  defaultWorkspaceConfig,
  isDefectAllowed,
  resolveEnabledDefects,
} from '../../../src/education/educational-policy.js';
import { FIXTURE_CATALOG } from './fixture-catalog.js';

const WS = 'ws-a';

const CONFIGS: Record<string, WorkspaceEducationalConfig> = {
  'STUDENT/ALL': { workspaceId: WS, mode: 'STUDENT', preset: { kind: 'ALL' } },
  'STUDENT/LAB-A': { workspaceId: WS, mode: 'STUDENT', preset: { kind: 'LAB', labId: 'lab-fixture-a' } },
  'STUDENT/LAB-B': { workspaceId: WS, mode: 'STUDENT', preset: { kind: 'LAB', labId: 'lab-fixture-b' } },
  'CONTROLLED/vazio': { workspaceId: WS, mode: 'CONTROLLED', enabledDefectIds: [] },
  'CONTROLLED/funcional': { workspaceId: WS, mode: 'CONTROLLED', enabledDefectIds: ['fixture-functional'] },
  'CONTROLLED/segurança': { workspaceId: WS, mode: 'CONTROLLED', enabledDefectIds: ['fixture-security'] },
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
      ISOLATED: ['fixture-functional', 'fixture-security', 'fixture-isolated-only'],
      SHARED: ['fixture-functional'],
    },
    'STUDENT/LAB-A': { ISOLATED: ['fixture-functional', 'fixture-security'], SHARED: ['fixture-functional'] },
    'STUDENT/LAB-B': { ISOLATED: ['fixture-isolated-only'], SHARED: [] },
    'CONTROLLED/vazio': { ISOLATED: [], SHARED: [] },
    'CONTROLLED/funcional': { ISOLATED: ['fixture-functional'], SHARED: ['fixture-functional'] },
    'CONTROLLED/segurança': { ISOLATED: ['fixture-security'], SHARED: [] },
  };
  const matrix = Object.keys(expected).flatMap((name) => ENVIRONMENT_KINDS.map((env) => [name, env] as const));

  it.each(matrix)('%s em %s', (name, env) => {
    expect(resolveEnabledDefects(CONFIGS[name]!, FIXTURE_CATALOG, env)).toEqual(expected[name]![env]);
  });

  it('ALL inclui automaticamente um defeito novo permitido, sem mudar a configuração', () => {
    const grown = {
      defects: [...FIXTURE_CATALOG.defects, { id: 'fixture-new', affectsSecurity: false, allowedEnvironments: ['SHARED'] as const }],
      labPresets: FIXTURE_CATALOG.labPresets,
    };
    expect(resolveEnabledDefects(CONFIGS['STUDENT/ALL']!, grown, 'SHARED')).toEqual(['fixture-functional', 'fixture-new']);
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
