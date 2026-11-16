import { describe, expect, it } from 'vitest';
import { DEFECT_CATALOG, validateCatalog } from '../../../src/education/defect-catalog.js';
import {
  InvalidEducationalConfigError,
  parseConfigChange,
  parseEnvironment,
  parseMode,
  parsePreset,
  parseWorkspaceId,
} from '../../../src/education/educational-mode.js';
import { FIXTURE_CATALOG } from './fixture-catalog.js';

function rejection(fn: () => unknown): InvalidEducationalConfigError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidEducationalConfigError);
    return error as InvalidEducationalConfigError;
  }
  throw new Error('esperava rejeição');
}

describe('parseMode', () => {
  it.each(['STUDENT', 'CONTROLLED'] as const)('aceita %s', (mode) => {
    expect(parseMode(mode)).toBe(mode);
  });

  it.each(['student', ' STUDENT', 'STUDENT ', 'Controlled', 'ALL', '', null, undefined, 1, {}, ['STUDENT']])(
    'rejeita %j sem coerção',
    (value) => {
      expect(rejection(() => parseMode(value)).field).toBe('mode');
    },
  );

  it('não ecoa o valor recebido na mensagem', () => {
    const error = rejection(() => parseMode('<script>segredo-x</script>'));
    expect(error.message).not.toMatch(/segredo-x|script/);
  });
});

describe('parseEnvironment', () => {
  it('ambiente ausente é tratado como SHARED (mais restritivo)', () => {
    expect(parseEnvironment(undefined)).toBe('SHARED');
  });

  it.each(['ISOLATED', 'SHARED'] as const)('aceita %s', (env) => {
    expect(parseEnvironment(env)).toBe(env);
  });

  it.each(['prod', 'isolated', 'LOCAL', '', null, 0])('rejeita ambiente desconhecido %j', (value) => {
    expect(rejection(() => parseEnvironment(value)).field).toBe('environment');
  });
});

describe('parseWorkspaceId', () => {
  it('aceita identificador não vazio', () => {
    expect(parseWorkspaceId('ws-a')).toBe('ws-a');
  });

  it.each(['', ' ws-a', 'ws-a ', null, 42])('rejeita %j', (value) => {
    expect(rejection(() => parseWorkspaceId(value)).field).toBe('workspaceId');
  });
});

describe('parsePreset', () => {
  it('aceita ALL', () => {
    expect(parsePreset({ kind: 'ALL' }, DEFECT_CATALOG)).toEqual({ kind: 'ALL' });
  });

  it('catálogo vigente vazio: nenhum preset de laboratório existe', () => {
    expect(rejection(() => parsePreset({ kind: 'LAB', labId: 'lab-fixture-a' }, DEFECT_CATALOG)).field).toBe(
      'preset.labId',
    );
  });

  it('aceita preset de laboratório existente no catálogo', () => {
    expect(parsePreset({ kind: 'LAB', labId: 'lab-fixture-a' }, FIXTURE_CATALOG)).toEqual({
      kind: 'LAB',
      labId: 'lab-fixture-a',
    });
  });

  it.each([
    'ALL',
    null,
    [],
    { kind: 'all' },
    { kind: 'TOTAL' },
    { kind: 'ALL', extra: true },
    { kind: 'LAB' },
    { kind: 'LAB', labId: 'inexistente' },
    { kind: 'LAB', labId: 'lab-fixture-a', defects: ['fixture-security'] },
  ])('rejeita %j', (value) => {
    rejection(() => parsePreset(value, FIXTURE_CATALOG));
  });
});

describe('parseConfigChange', () => {
  it('STUDENT sem preset assume ALL', () => {
    expect(parseConfigChange({ mode: 'STUDENT' }, DEFECT_CATALOG)).toEqual({ mode: 'STUDENT', preset: { kind: 'ALL' } });
  });

  it('CONTROLLED sem defeitos começa vazio', () => {
    expect(parseConfigChange({ mode: 'CONTROLLED' }, DEFECT_CATALOG)).toEqual({
      mode: 'CONTROLLED',
      enabledDefectIds: [],
    });
  });

  it('catálogo vigente vazio: qualquer defeito é rejeitado', () => {
    rejection(() => parseConfigChange({ mode: 'CONTROLLED', enabledDefectIds: ['fixture-functional'] }, DEFECT_CATALOG));
  });

  it.each([
    [{ mode: 'STUDENT', role: 'FACILITATOR' }, 'papel no payload'],
    [{ mode: 'CONTROLLED', workspaceId: 'ws-b' }, 'workspace no payload'],
    [{ mode: 'STUDENT', enabledDefectIds: [] }, 'defeitos em STUDENT'],
    [{ mode: 'CONTROLLED', preset: { kind: 'ALL' } }, 'preset em CONTROLLED'],
    [{ mode: 'CONTROLLED', enabledDefectIds: 'fixture-functional' }, 'lista não é array'],
    [{ mode: 'CONTROLLED', enabledDefectIds: ['fixture-functional', 'fixture-functional'] }, 'defeito repetido'],
    [{ mode: 'CONTROLLED', enabledDefectIds: ['nao-existe'] }, 'defeito inexistente'],
    [{ mode: 'CONTROLLED', enabledDefectIds: [1] }, 'id não textual'],
    [{ mode: 'controlled' }, 'modo em minúsculas'],
    [{}, 'sem modo'],
    [null, 'nulo'],
    [[], 'array'],
    ['STUDENT', 'texto'],
  ])('rejeita %j (%s)', (value: unknown, _caso: string) => {
    rejection(() => parseConfigChange(value, FIXTURE_CATALOG));
  });

  it('rejeita objeto com protótipo não simples', () => {
    const value = Object.assign(Object.create({ inherited: true }) as object, { mode: 'STUDENT' });
    rejection(() => parseConfigChange(value, FIXTURE_CATALOG));
  });
});

describe('catálogo', () => {
  it('catálogo vigente é vazio e congelado', () => {
    expect(DEFECT_CATALOG.defects).toEqual([]);
    expect(DEFECT_CATALOG.labPresets).toEqual([]);
    expect(Object.isFrozen(DEFECT_CATALOG)).toBe(true);
    expect(Object.isFrozen(DEFECT_CATALOG.defects)).toBe(true);
  });

  it.each([
    [{ defects: [{ id: 'x', affectsSecurity: false, allowedEnvironments: ['ISOLATED'] }, { id: 'x', affectsSecurity: false, allowedEnvironments: ['ISOLATED'] }], labPresets: [] }, 'id duplicado'],
    [{ defects: [{ id: 'x', affectsSecurity: false, allowedEnvironments: [] }], labPresets: [] }, 'sem ambiente'],
    [{ defects: [{ id: 'x', affectsSecurity: false, allowedEnvironments: ['PROD'] }], labPresets: [] }, 'ambiente desconhecido'],
    [{ defects: [], labPresets: [{ labId: 'l', defectIds: ['x'] }] }, 'preset com defeito inexistente'],
  ])('rejeita catálogo inconsistente (%j, %s)', (catalog: unknown, _caso: string) => {
    rejection(() => validateCatalog(catalog as Parameters<typeof validateCatalog>[0]));
  });
});
