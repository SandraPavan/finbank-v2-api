import { describe, expect, it, vi } from 'vitest';
import {
  ClockAccessLostError,
  ClockConflictError,
  type ClockPublishResult,
  type ClockState,
  ClockWorkspaceArchivedError,
  ClockWorkspaceNotFoundError,
  InvalidClockRequestError,
  parseClockChange,
  SimulationClockService,
  type SimulationClockStore,
} from '../../../src/simulation-clock/application/simulation-clock.service.js';
import { type BusinessDate, InvalidBusinessDateError } from '../../../src/simulation-clock/domain/business-date.js';
import type { WorkspaceAccess } from '../../../src/identity/domain/workspace-access.js';

const WS = '11111111-1111-4111-8111-111111111111';
const access: WorkspaceAccess = { identityId: '22222222-2222-4222-8222-222222222222', workspaceId: WS, role: 'FACILITATOR' };
const at = (date: string, revision: number): ClockState => ({ date: date as BusinessDate, revision });

function store(state: ClockState | null, result: ClockPublishResult = 'PUBLISHED') {
  return {
    current: vi.fn<SimulationClockStore['current']>().mockResolvedValue(state),
    publish: vi.fn<SimulationClockStore['publish']>().mockResolvedValue(result),
  };
}

describe('serviço do relógio simulado', () => {
  it('today devolve data e revisão vigentes; workspace inexistente é erro tipado', async () => {
    expect(await new SimulationClockService(store(at('2026-11-25', 0))).today(WS)).toEqual({ date: '2026-11-25', revision: 0 });
    await expect(new SimulationClockService(store(null)).today(WS)).rejects.toBeInstanceOf(ClockWorkspaceNotFoundError);
  });

  it('read informa workspace e fuso', async () => {
    expect(await new SimulationClockService(store(at('2026-11-25', 3))).read(access)).toEqual({
      workspaceId: WS, date: '2026-11-25', revision: 3, timeZone: 'America/Sao_Paulo',
    });
  });

  it('avança e retrocede gravando a revisão seguinte', async () => {
    for (const date of ['2027-04-30', '2001-01-01']) {
      const s = store(at('2026-11-25', 2));
      expect(await new SimulationClockService(s).change(access, 2, date, 'corr-0001')).toMatchObject({ date, revision: 3 });
      expect(s.publish).toHaveBeenCalledWith(access, 3, date, 'corr-0001');
    }
  });

  it('base diferente da vigente é conflito antes de validar a data, sem gravar', async () => {
    const s = store(at('2026-11-25', 2));
    for (const base of [0, 1, 3]) {
      await expect(new SimulationClockService(s).change(access, base, 'lixo', 'corr-0001')).rejects.toBeInstanceOf(ClockConflictError);
    }
    expect(s.publish).not.toHaveBeenCalled();
  });

  it('data recusada não grava', async () => {
    const s = store(at('2026-11-25', 0));
    await expect(new SimulationClockService(s).change(access, 0, '2027-02-30', 'corr-0001')).rejects.toBeInstanceOf(InvalidBusinessDateError);
    expect(s.publish).not.toHaveBeenCalled();
  });

  it('a mesma data vigente não grava e devolve o estado atual', async () => {
    const s = store(at('2026-11-25', 4));
    expect(await new SimulationClockService(s).change(access, 4, '2026-11-25', 'corr-0001')).toMatchObject({ date: '2026-11-25', revision: 4 });
    expect(s.publish).not.toHaveBeenCalled();
  });

  it.each<[ClockPublishResult, new () => Error]>([
    ['CONFLICT', ClockConflictError],
    ['DENIED', ClockAccessLostError],
    ['ARCHIVED', ClockWorkspaceArchivedError],
  ])('resultado %s vira erro tipado', async (result, type) => {
    await expect(new SimulationClockService(store(at('2026-11-25', 0), result)).change(access, 0, '2027-01-01', 'corr-0001')).rejects.toBeInstanceOf(type);
  });
});

describe('corpo da alteração do relógio', () => {
  it('aceita exatamente baseRevision e date', () => {
    expect(parseClockChange({ baseRevision: 0, date: 'qualquer' })).toEqual({ baseRevision: 0, date: 'qualquer' });
  });

  it.each<[string, unknown]>([
    ['nulo', null], ['lista', []], ['texto', 'x'], ['sem base', { date: '2027-01-01' }], ['sem data', { baseRevision: 0 }],
    ['base negativa', { baseRevision: -1, date: '2027-01-01' }], ['base texto', { baseRevision: '0', date: '2027-01-01' }],
    ['base fracionária', { baseRevision: 0.5, date: '2027-01-01' }], ['data numérica', { baseRevision: 0, date: 20270101 }],
    ['data nula', { baseRevision: 0, date: null }], ['campo extra', { baseRevision: 0, date: '2027-01-01', workspaceId: WS }],
    ['protótipo', Object.create({ baseRevision: 0, date: '2027-01-01' })],
  ])('%s: estrutura recusada', (_label, raw) => {
    expect(() => parseClockChange(raw)).toThrow(InvalidClockRequestError);
  });
});
