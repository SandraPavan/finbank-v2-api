import { describe, expect, it } from 'vitest';
import { PaymentExecutionError } from '../../../src/payment-execution/domain/errors.js';
import {
  parseReversalCommand,
  reversalFingerprint,
  reversalMovement,
} from '../../../src/payment-execution/domain/reversal.js';
import { parseTransferCommand, transferFingerprint } from '../../../src/payment-execution/domain/transfer.js';

const WS = '0b6f7c1e-4a2d-4c3b-9e8f-112233445566';
const OP = '5e5e5e5e-5555-4555-8555-555555555555';
const OTHER = '6f6f6f6f-6666-4666-8666-666666666666';
const A = '1a1a1a1a-1111-4111-8111-111111111111';
const B = '2b2b2b2b-2222-4222-8222-222222222222';

const valid = { workspaceId: WS, operationKey: 'rev-key-0001', originalOperationId: OP };

function rejection(fn: () => unknown): PaymentExecutionError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(PaymentExecutionError);
    return error as PaymentExecutionError;
  }
  throw new Error('esperava rejeição');
}

describe('parseReversalCommand', () => {
  it('aceita o comando válido e o congela', () => {
    const command = parseReversalCommand({ ...valid });
    expect(command).toEqual(valid);
    expect(Object.isFrozen(command)).toBe(true);
  });

  it.each([
    ['nulo', null],
    ['array', [valid]],
    ['string', 'x'],
    ['objeto sem protótipo simples', Object.assign(Object.create(null) as object, valid)],
    ['campo extra', { ...valid, amountCents: 10n }],
    ['sem workspace', { operationKey: valid.operationKey, originalOperationId: OP }],
    ['workspace maiúsculo', { ...valid, workspaceId: WS.toUpperCase() }],
    ['operação de origem não UUID', { ...valid, originalOperationId: 'op-1' }],
    ['operação de origem numérica', { ...valid, originalOperationId: 1 }],
    ['chave curta', { ...valid, operationKey: 'curta' }],
    ['chave com espaço', { ...valid, operationKey: 'chave com espaço' }],
  ])('rejeita %s como INVALID_INPUT', (_label, raw) => {
    expect(rejection(() => parseReversalCommand(raw)).code).toBe('INVALID_INPUT');
  });

  it('a mensagem não repete os valores recebidos', () => {
    const error = rejection(() => parseReversalCommand({ ...valid, originalOperationId: 'segredo-123' }));
    expect(error.message).not.toContain('segredo-123');
    expect(error.field).toBe('originalOperationId');
  });
});

describe('reversalFingerprint', () => {
  it('é SHA-256 hex determinístico', () => {
    const fp = reversalFingerprint(parseReversalCommand(valid));
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    expect(reversalFingerprint(parseReversalCommand({ ...valid }))).toBe(fp);
  });

  it('muda com a operação de origem e não depende da chave nem do workspace', () => {
    const fp = reversalFingerprint(parseReversalCommand(valid));
    expect(reversalFingerprint(parseReversalCommand({ ...valid, originalOperationId: OTHER }))).not.toBe(fp);
    expect(reversalFingerprint(parseReversalCommand({ ...valid, operationKey: 'rev-key-0002' }))).toBe(fp);
  });

  it('nunca coincide com a impressão de uma transferência', () => {
    const transfer = parseTransferCommand({
      workspaceId: WS,
      operationKey: valid.operationKey,
      debitAccountId: A,
      creditAccountId: B,
      amountCents: 1n,
    });
    expect(reversalFingerprint(parseReversalCommand(valid))).not.toBe(transferFingerprint(transfer));
  });
});

describe('reversalMovement', () => {
  it('inverte as contas e mantém o valor', () => {
    const movement = reversalMovement({ type: 'TRANSFER', debitAccountId: A, creditAccountId: B, amountCents: 300n });
    expect(movement).toEqual({ debitAccountId: B, creditAccountId: A, amountCents: 300n });
    expect(Object.isFrozen(movement)).toBe(true);
  });

  it('estorno de estorno é NOT_REVERSIBLE', () => {
    const error = rejection(() =>
      reversalMovement({ type: 'REVERSAL', debitAccountId: B, creditAccountId: A, amountCents: 300n }),
    );
    expect(error.code).toBe('NOT_REVERSIBLE');
  });
});
