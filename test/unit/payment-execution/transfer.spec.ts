import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PaymentExecutionError } from '../../../src/payment-execution/domain/errors.js';
import { MAX_CENTS } from '../../../src/payment-execution/domain/money.js';
import {
  balanceAfterCredit,
  balanceAfterDebit,
  isBalanced,
  ledgerEntriesFor,
  parseAccountKind,
  parseTransferCommand,
  transferFingerprint,
} from '../../../src/payment-execution/domain/transfer.js';

const WS = '0b6f7c1e-4a2d-4c3b-9e8f-112233445566';
const A = '1a1a1a1a-1111-4111-8111-111111111111';
const B = '2b2b2b2b-2222-4222-8222-222222222222';

function command(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { workspaceId: WS, operationKey: 'op-key-0001', debitAccountId: A, creditAccountId: B, amountCents: 250n, ...overrides };
}

function rejection(fn: () => unknown): PaymentExecutionError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(PaymentExecutionError);
    return error as PaymentExecutionError;
  }
  throw new Error('esperava rejeição');
}

describe('parseTransferCommand', () => {
  it('aceita comando válido e devolve objeto congelado', () => {
    const parsed = parseTransferCommand(command());
    expect(parsed).toEqual(command());
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it.each([
    ['nulo', null],
    ['array', [command()]],
    ['instância de classe', new (class Cmd {})()],
    ['string', 'x'],
  ])('rejeita %s', (_label, raw) => {
    expect(rejection(() => parseTransferCommand(raw)).code).toBe('INVALID_INPUT');
  });

  it.each(['balanceCents', 'role', 'kind', 'fingerprint'])('rejeita campo extra %s', (extra) => {
    const error = rejection(() => parseTransferCommand(command({ [extra]: 'x' })));
    expect(error.code).toBe('INVALID_INPUT');
    expect(error.field).toBe('comando');
  });

  it.each([
    ['workspaceId', 'nao-uuid'],
    ['workspaceId', WS.toUpperCase()],
    ['debitAccountId', ` ${A}`],
    ['creditAccountId', 42],
    ['operationKey', 'curta'],
    ['operationKey', 'chave com espaço'],
    ['operationKey', 'x'.repeat(129)],
    ['operationKey', 'chave-çãé-0001'],
    ['amountCents', 250],
  ])('rejeita %s inválido sem eco', (field, value) => {
    const error = rejection(() => parseTransferCommand(command({ [field]: value })));
    expect(error.code).toBe('INVALID_INPUT');
    expect(error.field).toBe(field);
    expect(error.message).not.toContain(String(value).trim());
  });

  it('aceita chave nos limites de 8 e 128 caracteres', () => {
    expect(parseTransferCommand(command({ operationKey: 'A'.repeat(8) })).operationKey).toHaveLength(8);
    expect(parseTransferCommand(command({ operationKey: 'a_-9'.repeat(32) })).operationKey).toHaveLength(128);
  });

  it('rejeita mesma conta como origem e destino', () => {
    expect(rejection(() => parseTransferCommand(command({ creditAccountId: A }))).code).toBe('SAME_ACCOUNT');
  });

  it('rejeita valor acima do limite técnico', () => {
    expect(rejection(() => parseTransferCommand(command({ amountCents: MAX_CENTS + 1n }))).code).toBe(
      'AMOUNT_OUT_OF_RANGE',
    );
  });
});

describe('parseAccountKind', () => {
  it.each(['STANDARD', 'CONTRA'])('aceita %s', (kind) => {
    expect(parseAccountKind(kind)).toBe(kind);
  });

  it.each(['standard', 'ADMIN', '', null])('rejeita %s', (kind) => {
    expect(rejection(() => parseAccountKind(kind)).code).toBe('INVALID_INPUT');
  });
});

describe('transferFingerprint', () => {
  it('é SHA-256 hex da forma canônica versionada', () => {
    const parsed = parseTransferCommand(command());
    const expected = createHash('sha256')
      .update(JSON.stringify({ v: 1, debitAccountId: A, creditAccountId: B, amountCents: '250' }))
      .digest('hex');
    expect(transferFingerprint(parsed)).toBe(expected);
    expect(transferFingerprint(parsed)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('é estável e independe da ordem dos campos e da chave de operação', () => {
    const a = parseTransferCommand(command());
    const b = parseTransferCommand({
      amountCents: 250n,
      creditAccountId: B,
      debitAccountId: A,
      operationKey: 'outra-chave-0002',
      workspaceId: WS,
    });
    expect(transferFingerprint(a)).toBe(transferFingerprint(b));
  });

  it.each([
    ['valor', { amountCents: 251n }],
    ['origem/destino invertidos', { debitAccountId: B, creditAccountId: A }],
  ])('muda quando o conteúdo muda (%s)', (_label, change) => {
    expect(transferFingerprint(parseTransferCommand(command(change)))).not.toBe(
      transferFingerprint(parseTransferCommand(command())),
    );
  });

  it('preserva a precisão de valores acima do inteiro seguro', () => {
    const big = parseTransferCommand(command({ amountCents: 9_007_199_254_740_993n }));
    const neighbor = parseTransferCommand(command({ amountCents: 9_007_199_254_740_992n }));
    expect(transferFingerprint(big)).not.toBe(transferFingerprint(neighbor));
  });
});

describe('ledgerEntriesFor e isBalanced', () => {
  it('gera débito negativo na origem e crédito positivo no destino, somando zero', () => {
    const entries = ledgerEntriesFor(parseTransferCommand(command()));
    expect(entries).toEqual([
      { accountId: A, amountCents: -250n },
      { accountId: B, amountCents: 250n },
    ]);
    expect(isBalanced(entries)).toBe(true);
  });

  it('detecta desequilíbrio e lançamento único', () => {
    expect(isBalanced([{ accountId: A, amountCents: -1n }, { accountId: B, amountCents: 2n }])).toBe(false);
    expect(isBalanced([{ accountId: A, amountCents: 0n }])).toBe(false);
  });
});

describe('saldos', () => {
  it('conta comum pode chegar a zero, mas não ficar negativa', () => {
    expect(balanceAfterDebit('STANDARD', 100n, 100n)).toBe(0n);
    expect(rejection(() => balanceAfterDebit('STANDARD', 100n, 101n)).code).toBe('INSUFFICIENT_FUNDS');
  });

  it('contrapartida pode ficar negativa dentro do limite técnico', () => {
    expect(balanceAfterDebit('CONTRA', 0n, 500n)).toBe(-500n);
    expect(rejection(() => balanceAfterDebit('CONTRA', -MAX_CENTS, 1n)).code).toBe('AMOUNT_OUT_OF_RANGE');
  });

  it('crédito respeita o limite técnico', () => {
    expect(balanceAfterCredit(MAX_CENTS - 1n, 1n)).toBe(MAX_CENTS);
    expect(rejection(() => balanceAfterCredit(MAX_CENTS, 1n)).code).toBe('AMOUNT_OUT_OF_RANGE');
  });
});
