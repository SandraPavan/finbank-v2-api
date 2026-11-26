import { describe, expect, it } from 'vitest';
import { type DefectCatalog, DEFECT_CATALOG, OPERATION_KEYS, validateCatalog } from '../../../src/education/defect-catalog.js';
import {
  hashLabCode,
  InvalidEducationalConfigError,
  parseConfigChange,
  parseEnvironment,
  parseLabCode,
  parseMode,
  parseOperation,
  parsePreset,
  parseWorkspaceId,
  resolveLabPreset,
} from '../../../src/education/educational-mode.js';
import { CODE_1, CODE_UNKNOWN, FIXTURE_CATALOG, ID_A, ID_C, ID_D, OP_X } from './fixture-catalog.js';

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

describe('código de laboratório', () => {
  it('representa o código por SHA-256 em hexadecimal minúsculo (vetor calculado externamente)', () => {
    expect(hashLabCode('ABCD-1234')).toBe('01ce39a48e5f5e14ef4a9074f5dfce4eea6d27d766ce554f6a9f92cf078e936b');
  });

  it.each(['ABCD-1234', 'A1B2C3D4', '0123456789-ABCDEFGHIJ-0123456789'])('aceita o formato %j', (code) => {
    expect(parseLabCode(code)).toBe(hashLabCode(code));
  });

  it.each([
    ['abcd-1234', 'minúsculas'],
    [' ABCD-1234', 'espaço inicial'],
    ['ABCD-1234 ', 'espaço final'],
    ['ABCD_1234', 'caractere fora do alfabeto'],
    ['ABCD-12', 'curto (7)'],
    ['A'.repeat(33), 'longo (33)'],
    ['ÁBCD-1234', 'acentuado'],
    ['', 'vazio'],
    [12345678, 'número'],
    [null, 'nulo'],
  ])('rejeita %j (%s)', (value: unknown, _caso: string) => {
    rejection(() => parseLabCode(value));
  });

  it('o mesmo código resolve sempre o mesmo preset', () => {
    expect(resolveLabPreset(CODE_1, FIXTURE_CATALOG)).toEqual(resolveLabPreset(CODE_1, FIXTURE_CATALOG));
    expect(resolveLabPreset(CODE_1, FIXTURE_CATALOG)).toEqual({ kind: 'LAB', codeHash: hashLabCode(CODE_1) });
  });

  it('código com formato válido fora do catálogo é rejeitado', () => {
    rejection(() => resolveLabPreset(CODE_UNKNOWN, FIXTURE_CATALOG));
  });

  it('catálogo vigente vazio: nenhum código resolve preset', () => {
    rejection(() => resolveLabPreset(CODE_1, DEFECT_CATALOG));
  });

  it.each([CODE_1, CODE_UNKNOWN, 'abcd-invalido-segredo'])('mensagens nunca exibem o código nem o hash (%s)', (code) => {
    const error = rejection(() => resolveLabPreset(code, DEFECT_CATALOG));
    expect(error.message).not.toContain(code);
    expect(error.message).not.toContain(hashLabCode(code));
    expect(error.message).not.toMatch(/[0-9a-f]{64}/);
  });
});

describe('parsePreset', () => {
  it('aceita NONE', () => {
    expect(parsePreset({ kind: 'NONE' }, FIXTURE_CATALOG)).toEqual({ kind: 'NONE' });
  });

  it('aceita ALL', () => {
    expect(parsePreset({ kind: 'ALL' }, DEFECT_CATALOG)).toEqual({ kind: 'ALL' });
  });

  it('LAB recebe o código e armazena somente o hash', () => {
    const preset = parsePreset({ kind: 'LAB', code: CODE_1 }, FIXTURE_CATALOG);
    expect(preset).toEqual({ kind: 'LAB', codeHash: hashLabCode(CODE_1) });
    expect(JSON.stringify(preset)).not.toContain(CODE_1);
  });

  it.each([
    'ALL',
    null,
    [],
    { kind: 'all' },
    { kind: 'TOTAL' },
    { kind: 'ALL', extra: true },
    { kind: 'LAB' },
    { kind: 'LAB', code: CODE_UNKNOWN },
    { kind: 'LAB', codeHash: hashLabCode(CODE_1) },
    { kind: 'LAB', labId: 'qualquer' },
    { kind: 'LAB', code: CODE_1, defects: [ID_A] },
  ])('rejeita %j', (value) => {
    rejection(() => parsePreset(value, FIXTURE_CATALOG));
  });
});

describe('parseConfigChange', () => {
  it('STUDENT exige preset escrito', () => {
    expect(rejection(() => parseConfigChange({ mode: 'STUDENT' }, DEFECT_CATALOG)).field).toBe('preset');
    expect(parseConfigChange({ mode: 'STUDENT', preset: { kind: 'NONE' } }, DEFECT_CATALOG)).toEqual({ mode: 'STUDENT', preset: { kind: 'NONE' } });
  });

  it('CONTROLLED sem defeitos começa vazio', () => {
    expect(parseConfigChange({ mode: 'CONTROLLED' }, DEFECT_CATALOG)).toEqual({ mode: 'CONTROLLED', enabledDefectIds: [] });
  });

  it('catálogo vigente vazio: qualquer defeito é rejeitado', () => {
    rejection(() => parseConfigChange({ mode: 'CONTROLLED', enabledDefectIds: [ID_A] }, DEFECT_CATALOG));
  });

  it.each([
    [{ mode: 'STUDENT', preset: { kind: 'NONE' }, role: 'FACILITATOR' }, 'papel no payload'],
    [{ mode: 'CONTROLLED', workspaceId: 'ws-b' }, 'workspace no payload'],
    [{ mode: 'STUDENT', preset: { kind: 'NONE' }, enabledDefectIds: [] }, 'defeitos em STUDENT'],
    [{ mode: 'STUDENT', preset: { kind: 'NONE', code: 'X' } }, 'campo extra em NONE'],
    [{ mode: 'STUDENT', preset: { kind: 'none' } }, 'NONE em minúsculas'],
    [{ mode: 'STUDENT', preset: null }, 'preset nulo'],
    [{ mode: 'CONTROLLED', preset: { kind: 'ALL' } }, 'preset em CONTROLLED'],
    [{ mode: 'CONTROLLED', enabledDefectIds: ID_A }, 'lista não é array'],
    [{ mode: 'CONTROLLED', enabledDefectIds: [ID_A, ID_A] }, 'defeito repetido'],
    [{ mode: 'CONTROLLED', enabledDefectIds: ['d-0000000000000000'] }, 'defeito inexistente'],
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
    const value = Object.assign(Object.create({ inherited: true }) as object, { mode: 'CONTROLLED' });
    rejection(() => parseConfigChange(value, FIXTURE_CATALOG));
  });
});

describe('parseOperation', () => {
  it('aceita só operações do catálogo, sem ecoar o valor', () => {
    expect(parseOperation(OP_X, FIXTURE_CATALOG)).toBe(OP_X);
    const error = rejection(() => parseOperation('OPERACAO_SECRETA_123', FIXTURE_CATALOG));
    expect(error.message).not.toContain('OPERACAO_SECRETA_123');
  });
});

describe('catálogo', () => {
  it('catálogo vigente: vazio, versionado, sem operações e congelado', () => {
    expect(DEFECT_CATALOG).toEqual({ version: '2026.11.1', operations: [], defects: [], labPresets: [] });
    expect(OPERATION_KEYS).toEqual([]);
    for (const part of [DEFECT_CATALOG, DEFECT_CATALOG.defects, DEFECT_CATALOG.labPresets, DEFECT_CATALOG.operations]) {
      expect(Object.isFrozen(part)).toBe(true);
    }
  });

  const OP = 'OPERACAO_FICTICIA';
  const valid = { id: ID_A, affectsSecurity: false, allowedEnvironments: ['ISOLATED'], operations: [OP], incompatibleWith: [] };
  const other = { ...valid, id: ID_C };
  const catalog = (patch: object): DefectCatalog => ({ version: '2026.01.1', operations: [OP], defects: [valid], labPresets: [], ...patch }) as DefectCatalog;

  it('aceita catálogo mínimo válido', () => {
    expect(validateCatalog(catalog({}))).toBeTruthy();
  });

  it.each([
    [{ version: '2026.13.1' }, 'mês inválido'],
    [{ version: '2026.1.1' }, 'mês sem zero'],
    [{ version: '2026.01.0' }, 'sequência zero'],
    [{ version: 'v1' }, 'versão livre'],
    [{ operations: ['operacao'] }, 'operação em minúsculas'],
    [{ operations: [OP, OP] }, 'operação repetida'],
    [{ defects: [{ ...valid, id: 'identificador-legivel' }] }, 'id legível'],
    [{ defects: [{ ...valid, id: 'd-FDF709B001BAB397' }] }, 'id em maiúsculas'],
    [{ defects: [valid, valid] }, 'id duplicado'],
    [{ defects: [{ ...valid, allowedEnvironments: [] }] }, 'sem ambiente'],
    [{ defects: [{ ...valid, allowedEnvironments: ['PROD'] }] }, 'ambiente desconhecido'],
    [{ defects: [{ ...valid, operations: [] }] }, 'sem operação'],
    [{ defects: [{ ...valid, operations: ['OUTRA_OPERACAO'] }] }, 'operação fora do catálogo'],
    [{ defects: [{ ...valid, operations: [OP, OP] }] }, 'operação repetida no defeito'],
    [{ defects: [{ ...valid, incompatibleWith: [ID_A] }] }, 'incompatível consigo'],
    [{ defects: [{ ...valid, incompatibleWith: [ID_D] }] }, 'incompatível com inexistente'],
    [{ defects: [{ ...valid, incompatibleWith: [ID_C] }, other] }, 'incompatibilidade assimétrica'],
    [{ defects: [{ ...valid, incompatibleWith: [ID_C, ID_C] }, { ...other, incompatibleWith: [ID_A] }] }, 'incompatibilidade repetida'],
    [{ labPresets: [{ codeHash: CODE_1, defectIds: [ID_A] }] }, 'código em claro no lugar do hash'],
    [{ labPresets: [{ codeHash: hashLabCode(CODE_1), defectIds: [] }] }, 'preset vazio'],
    [{ labPresets: [{ codeHash: hashLabCode(CODE_1), defectIds: ['d-0000000000000000'] }] }, 'defeito inexistente'],
    [{ labPresets: [{ codeHash: hashLabCode(CODE_1), defectIds: [ID_A, ID_A] }] }, 'preset com repetição'],
    [
      { defects: [{ ...valid, incompatibleWith: [ID_C] }, { ...other, incompatibleWith: [ID_A] }], labPresets: [{ codeHash: hashLabCode(CODE_1), defectIds: [ID_A, ID_C] }] },
      'preset com par incompatível',
    ],
    [{ labPresets: [{ codeHash: hashLabCode(CODE_1), defectIds: [ID_A] }, { codeHash: hashLabCode(CODE_1), defectIds: [ID_A] }] }, 'hash duplicado'],
  ])('rejeita catálogo inconsistente (%j, %s)', (patch: object, _caso: string) => {
    rejection(() => validateCatalog(catalog(patch)));
  });
});
