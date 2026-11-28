import { describe, expect, it, vi } from 'vitest';
import { AccountStatementService, type AccountStatementReader } from '../../../src/bank-account/application/account-statement.service.js';
import { BankAccountError, BankAccountService, type BankAccountStore } from '../../../src/bank-account/application/bank-account.service.js';
import {
  decodeCursor,
  encodeCursor,
  InvalidStatementQueryError,
  type LedgerLine,
  parseStatementQuery,
  STATEMENT_DEFAULT_LIMIT,
  STATEMENT_MAX_LIMIT,
  StatementDataError,
  toStatementItem,
} from '../../../src/bank-account/domain/statement.js';
import { OPENAPI_DOCUMENT } from '../../../src/http/openapi.js';
import type { WorkspaceAccess } from '../../../src/identity/domain/workspace-access.js';

const WS = '11111111-1111-4111-8111-111111111111';
const CUSTOMER = '33333333-3333-4333-8333-333333333333';
const ACCOUNT = '44444444-4444-4444-8444-444444444444';
const ENTRY = '55555555-5555-4555-8555-555555555555';
const OP = '66666666-6666-4666-8666-666666666666';
const MAX_BIGINT = 9_223_372_036_854_775_807n;

const own: WorkspaceAccess = { identityId: CUSTOMER, workspaceId: WS, role: 'CUSTOMER' };
const desk: WorkspaceAccess = { identityId: '22222222-2222-4222-8222-222222222222', workspaceId: WS, role: 'FACILITATOR' };

const line = (over: Partial<LedgerLine> = {}): LedgerLine => ({
  entryId: ENTRY, operationId: OP, type: 'EDUCATIONAL_CREDIT', modality: null, amountCents: 15_000n, reversesOperationId: null,
  occurredAt: new Date('2026-11-27T12:00:00.123Z'), ...over,
});

function refused(work: () => unknown): InvalidStatementQueryError {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidStatementQueryError);
    return error as InvalidStatementQueryError;
  }
  throw new Error('não recusou');
}

describe('consulta do extrato', () => {
  it('padrão 20, máximo 100, sem cursor', () => {
    expect(parseStatementQuery({})).toEqual({ limit: STATEMENT_DEFAULT_LIMIT, after: null });
    expect(parseStatementQuery({ limit: '1' }).limit).toBe(1);
    expect(parseStatementQuery({ limit: '100' }).limit).toBe(STATEMENT_MAX_LIMIT);
  });

  it('os limites são os documentados no contrato', () => {
    const schema = OPENAPI_DOCUMENT.components.parameters.StatementLimit.schema;
    expect(schema).toMatchObject({ maximum: STATEMENT_MAX_LIMIT, default: STATEMENT_DEFAULT_LIMIT });
  });

  it.each<[string, unknown]>([['zero', '0'], ['acima do máximo', '101'], ['negativo', '-1'], ['decimal', '1.5'], ['zero à esquerda', '05'], ['texto', 'dez'], ['vazio', ''], ['repetido', ['1', '2']], ['objeto', { a: '1' }]])(
    'limit %s é 400 com o campo',
    (_label, limit) => {
      expect(refused(() => parseStatementQuery({ limit })).fields).toEqual(['limit']);
    },
  );

  it.each<[string, unknown]>([
    ['vazio', ''], ['outro formato', 'abc'], ['versão desconhecida', `s2.1.${ENTRY}`], ['sem id', 's1.1'], ['id malformado', 's1.1.xyz'],
    ['instante negativo', `s1.-1.${ENTRY}`], ['zero à esquerda', `s1.01.${ENTRY}`], ['fora do intervalo de datas', `s1.9999999999999999.${ENTRY}`],
    ['maiúsculas', 's1.1.AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'], ['repetido', [`s1.1.${ENTRY}`, `s1.2.${ENTRY}`]],
  ])('cursor %s é 400 com o campo', (_label, cursor) => {
    expect(refused(() => parseStatementQuery({ cursor })).fields).toEqual(['cursor']);
  });

  it('parâmetro desconhecido é 400', () => {
    expect(refused(() => parseStatementQuery({ offset: '0' })).fields).toEqual([]);
    expect(refused(() => parseStatementQuery({ workspaceId: WS })).fields).toEqual([]);
  });

  it('cursor ida e volta preserva instante (ms) e id', () => {
    const position = { occurredAt: new Date('2026-11-27T12:00:00.123Z'), entryId: ENTRY };
    const cursor = encodeCursor(position);
    expect(decodeCursor(cursor)).toEqual(position);
    expect(parseStatementQuery({ cursor }).after).toEqual(position);
  });
});

describe('item do extrato', () => {
  it('crédito: direção pelo sinal, valor positivo e exato', () => {
    expect(toStatementItem(line())).toEqual({
      entryId: ENTRY, operationId: OP, type: 'EDUCATIONAL_CREDIT', modality: null, direction: 'CREDIT', amount: '150.00', status: 'COMPLETED',
      reversesOperationId: null, occurredAt: '2026-11-27T12:00:00.123Z',
    });
  });

  it('débito e estorno, com modalidade', () => {
    expect(toStatementItem(line({ type: 'TRANSFER', modality: 'PIX_KEY', amountCents: -1n }))).toMatchObject({ direction: 'DEBIT', amount: '0.01', modality: 'PIX_KEY' });
    expect(toStatementItem(line({ type: 'REVERSAL', reversesOperationId: OP, amountCents: 99n }))).toMatchObject({ type: 'REVERSAL', reversesOperationId: OP, amount: '0.99' });
  });

  it('valores extremos sem perda de precisão', () => {
    expect(toStatementItem(line({ amountCents: MAX_BIGINT })).amount).toBe('92233720368547758.07');
    expect(toStatementItem(line({ amountCents: -MAX_BIGINT })).amount).toBe('92233720368547758.07');
  });

  it.each<[string, Partial<LedgerLine>]>([['tipo desconhecido', { type: 'PIX' }], ['modalidade desconhecida', { modality: 'BOLETO' }], ['valor zero', { amountCents: 0n }]])(
    '%s é dado inconsistente, nunca apresentado',
    (_label, over) => {
      expect(() => toStatementItem(line(over))).toThrow(StatementDataError);
    },
  );
});

describe('AccountStatementService', () => {
  const setup = (lines: LedgerLine[] = []) => {
    const reader = {
      account: vi.fn<AccountStatementReader['account']>().mockResolvedValue({ accountId: ACCOUNT, status: 'ACTIVE', balance: 15_000n }),
      entries: vi.fn<AccountStatementReader['entries']>().mockResolvedValue(lines),
    };
    return { reader, service: new AccountStatementService(reader) };
  };

  it('conta própria: pela identidade confirmada, saldo em texto e BRL', async () => {
    const { reader, service } = setup();
    await expect(service.ownAccount(own)).resolves.toEqual({ accountId: ACCOUNT, status: 'ACTIVE', balance: '150.00', currency: 'BRL' });
    expect(reader.account).toHaveBeenCalledWith(WS, CUSTOMER);
  });

  it('saldo negativo de conta comum é dado inconsistente', async () => {
    const { reader, service } = setup();
    reader.account.mockResolvedValue({ accountId: ACCOUNT, status: 'ACTIVE', balance: -1n });
    await expect(service.ownAccount(own)).rejects.toBeInstanceOf(StatementDataError);
  });

  it('sem conta é NOT_FOUND, para o cliente e para o facilitador', async () => {
    const { reader, service } = setup();
    reader.account.mockResolvedValue(null);
    await expect(service.ownAccount(own)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(service.ownStatement(own, {})).rejects.toBeInstanceOf(BankAccountError);
    await expect(service.customerStatement(desk, CUSTOMER, {})).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('cliente malformado é NOT_FOUND sem consulta', async () => {
    const { reader, service } = setup();
    await expect(service.customerStatement(desk, 'x', {})).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(reader.account).not.toHaveBeenCalled();
  });

  it('consulta inválida é recusada antes da leitura', async () => {
    const { reader, service } = setup();
    await expect(service.ownStatement(own, { limit: '0' })).rejects.toBeInstanceOf(InvalidStatementQueryError);
    expect(reader.account).not.toHaveBeenCalled();
  });

  it('pede um a mais e devolve o cursor do último entregue', async () => {
    const lines = [0, 1, 2].map((i) => line({ entryId: `5555555${i}-5555-4555-8555-555555555555`, occurredAt: new Date(1_000 - i) }));
    const { reader, service } = setup(lines);
    const page = await service.customerStatement(desk, CUSTOMER, { limit: '2' });
    expect(reader.entries).toHaveBeenCalledWith(WS, ACCOUNT, 3, null);
    expect(page.items.map((i) => i.entryId)).toEqual([lines[0]?.entryId, lines[1]?.entryId]);
    expect(page.nextCursor).toBe(`s1.999.${lines[1]?.entryId}`);
  });

  it('última página: sem cursor; a posição recebida é repassada', async () => {
    const { reader, service } = setup([line()]);
    const page = await service.ownStatement(own, { cursor: `s1.5000.${ENTRY}` });
    expect(reader.entries).toHaveBeenCalledWith(WS, ACCOUNT, 21, { occurredAt: new Date(5000), entryId: ENTRY });
    expect(page).toMatchObject({ accountId: ACCOUNT, nextCursor: null });
  });
});

describe('consulta da conta pelo facilitador', () => {
  it('inclui o saldo materializado em texto', async () => {
    const store = {
      view: vi.fn<BankAccountStore['view']>().mockResolvedValue({ customerId: CUSTOMER, accountId: ACCOUNT, status: 'BLOCKED', balance: 1n, history: [] }),
      change: vi.fn<BankAccountStore['change']>(),
    };
    await expect(new BankAccountService(store).view(desk, CUSTOMER)).resolves.toEqual({
      workspaceId: WS, customerId: CUSTOMER, accountId: ACCOUNT, status: 'BLOCKED', balance: '0.01', history: [],
    });
  });
});
