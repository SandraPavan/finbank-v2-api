import { describe, expect, it, vi } from 'vitest';
import {
  BankAccountError,
  BankAccountService,
  type BankAccountStore,
  type StatusChangeResult,
} from '../../../src/bank-account/application/bank-account.service.js';
import { InvalidJustificationError, parseJustification } from '../../../src/bank-account/domain/account-status.js';
import type { WorkspaceAccess } from '../../../src/identity/domain/workspace-access.js';

const WS = '11111111-1111-4111-8111-111111111111';
const CUSTOMER = '33333333-3333-4333-8333-333333333333';
const ACCOUNT = '44444444-4444-4444-8444-444444444444';
const access: WorkspaceAccess = { identityId: '22222222-2222-4222-8222-222222222222', workspaceId: WS, role: 'FACILITATOR' };

describe('justificativa', () => {
  it('apara as pontas e aceita de 10 a 200 caracteres (pontos de código)', () => {
    expect(parseJustification({ justification: '  Suspeita de uso indevido  ' })).toBe('Suspeita de uso indevido');
    expect(parseJustification({ justification: 'x'.repeat(10) })).toBe('x'.repeat(10));
    expect(parseJustification({ justification: '😀'.repeat(200) })).toHaveLength(400);
  });

  it.each<[string, unknown]>([
    ['curta', { justification: 'curta' }], ['só espaços', { justification: ' '.repeat(20) }], ['longa', { justification: 'x'.repeat(201) }],
    ['quebra de linha', { justification: 'motivo com\nquebra de linha' }], ['nulo no meio', { justification: 'motivo com \u0000 nulo' }],
    ['número', { justification: 12345678901 }], ['ausente', {}], ['campo extra', { justification: 'motivo suficiente', status: 'ACTIVE' }],
    ['lista', []], ['nulo', null],
  ])('%s é recusada sem repetir o valor', (_label, body) => {
    const error = (() => {
      try {
        parseJustification(body);
      } catch (e) {
        return e as Error;
      }
      throw new Error('não recusou');
    })();
    expect(error).toBeInstanceOf(InvalidJustificationError);
    expect(error.message).not.toMatch(/curta|quebra|motivo/);
  });
});

function setup(result: StatusChangeResult = { kind: 'CHANGED', accountId: ACCOUNT, status: 'BLOCKED' }) {
  const store = {
    view: vi.fn<BankAccountStore['view']>().mockResolvedValue(null),
    change: vi.fn<BankAccountStore['change']>().mockResolvedValue(result),
  };
  return { store, service: new BankAccountService(store) };
}

describe('serviço da conta', () => {
  it('muda o estado e devolve a conta; a justificativa só vai à gravação', async () => {
    const { store, service } = setup();
    expect(await service.change(access, CUSTOMER, 'BLOCKED', 'Suspeita de uso indevido', 'corr-0001')).toEqual({
      workspaceId: WS, customerId: CUSTOMER, accountId: ACCOUNT, status: 'BLOCKED',
    });
    expect(store.change).toHaveBeenCalledWith(access, CUSTOMER, 'BLOCKED', 'Suspeita de uso indevido', 'corr-0001');
  });

  it.each<[StatusChangeResult, string]>([
    [{ kind: 'NOT_FOUND' }, 'NOT_FOUND'], [{ kind: 'DENIED' }, 'ACCESS_LOST'], [{ kind: 'ARCHIVED' }, 'WORKSPACE_ARCHIVED'],
  ])('resultado %j vira erro tipado', async (result, code) => {
    await expect(setup(result).service.change(access, CUSTOMER, 'BLOCKED', 'Suspeita de uso indevido', 'corr-0001')).rejects.toMatchObject({ code });
  });

  it('cliente malformado ou sem conta é NOT_FOUND; malformado nem chega à gravação', async () => {
    const { store, service } = setup();
    await expect(service.change(access, 'x', 'BLOCKED', 'Suspeita de uso indevido', 'corr-0001')).rejects.toBeInstanceOf(BankAccountError);
    await expect(service.view(access, CUSTOMER)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(store.change).not.toHaveBeenCalled();
  });
});
