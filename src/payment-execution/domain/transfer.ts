import { createHash } from 'node:crypto';
import { invalidInput, PaymentExecutionError } from './errors.js';
import { MAX_CENTS, parseAmountCents } from './money.js';

export const ACCOUNT_KINDS = ['STANDARD', 'CONTRA'] as const;
/** STANDARD não pode ficar negativa; CONTRA é a contrapartida do workspace e pode. */
export type AccountKind = (typeof ACCOUNT_KINDS)[number];

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const OPERATION_KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

const COMMAND_KEYS = ['workspaceId', 'operationKey', 'debitAccountId', 'creditAccountId', 'amountCents'] as const;

export interface TransferCommand {
  readonly workspaceId: string;
  readonly operationKey: string;
  readonly debitAccountId: string;
  readonly creditAccountId: string;
  readonly amountCents: bigint;
}

/** Lançamento a gravar: valor com sinal (débito negativo, crédito positivo). */
export interface LedgerEntryDraft {
  readonly accountId: string;
  readonly amountCents: bigint;
}

function isPlainObject(raw: unknown): raw is Record<string, unknown> {
  return (
    typeof raw === 'object' && raw !== null && !Array.isArray(raw) && Object.getPrototypeOf(raw) === Object.prototype
  );
}

export function parseUuid(raw: unknown, field: string): string {
  if (typeof raw !== 'string' || !UUID_PATTERN.test(raw)) {
    throw invalidInput(field, 'deve ser um UUID em minúsculas');
  }
  return raw;
}

export function parseAccountKind(raw: unknown): AccountKind {
  if (typeof raw !== 'string' || !(ACCOUNT_KINDS as readonly string[]).includes(raw)) {
    throw invalidInput('kind', `deve ser ${ACCOUNT_KINDS.join(' ou ')}`);
  }
  return raw as AccountKind;
}

/** Validação estrita do comando: objeto simples, somente os campos esperados, sem coerção. */
export function parseTransferCommand(raw: unknown): TransferCommand {
  if (!isPlainObject(raw)) {
    throw invalidInput('comando', 'deve ser um objeto simples');
  }
  if (Object.keys(raw).some((key) => !(COMMAND_KEYS as readonly string[]).includes(key))) {
    throw invalidInput('comando', `aceita somente os campos ${COMMAND_KEYS.join(', ')}`);
  }
  const workspaceId = parseUuid(raw['workspaceId'], 'workspaceId');
  const operationKey = raw['operationKey'];
  if (typeof operationKey !== 'string' || !OPERATION_KEY_PATTERN.test(operationKey)) {
    throw invalidInput('operationKey', 'deve ter de 8 a 128 caracteres A-Z, a-z, 0-9, hífen ou sublinhado');
  }
  const debitAccountId = parseUuid(raw['debitAccountId'], 'debitAccountId');
  const creditAccountId = parseUuid(raw['creditAccountId'], 'creditAccountId');
  const amountCents = parseAmountCents(raw['amountCents']);
  if (debitAccountId === creditAccountId) {
    throw new PaymentExecutionError('SAME_ACCOUNT');
  }
  return Object.freeze({ workspaceId, operationKey, debitAccountId, creditAccountId, amountCents });
}

/**
 * Impressão digital do conteúdo da operação (SHA-256 hex da forma canônica versionada).
 * O workspace e a chave já identificam a operação e por isso não entram no conteúdo.
 */
export function transferFingerprint(command: TransferCommand): string {
  const canonical = JSON.stringify({
    v: 1,
    debitAccountId: command.debitAccountId,
    creditAccountId: command.creditAccountId,
    amountCents: command.amountCents.toString(10),
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/** Par de lançamentos de dupla entrada; a soma é sempre zero. */
export function ledgerEntriesFor(command: TransferCommand): readonly [LedgerEntryDraft, LedgerEntryDraft] {
  return Object.freeze([
    Object.freeze({ accountId: command.debitAccountId, amountCents: -command.amountCents }),
    Object.freeze({ accountId: command.creditAccountId, amountCents: command.amountCents }),
  ] as const);
}

export function isBalanced(entries: readonly LedgerEntryDraft[]): boolean {
  return entries.length >= 2 && entries.reduce((sum, entry) => sum + entry.amountCents, 0n) === 0n;
}

/** Novo saldo após débito. Conta STANDARD não pode ficar negativa. */
export function balanceAfterDebit(kind: AccountKind, balance: bigint, amount: bigint): bigint {
  const next = balance - amount;
  if (kind === 'STANDARD' && next < 0n) {
    throw new PaymentExecutionError('INSUFFICIENT_FUNDS');
  }
  if (next < -MAX_CENTS) {
    throw new PaymentExecutionError('AMOUNT_OUT_OF_RANGE');
  }
  return next;
}

/** Novo saldo após crédito, dentro do limite técnico. */
export function balanceAfterCredit(balance: bigint, amount: bigint): bigint {
  const next = balance + amount;
  if (next > MAX_CENTS) {
    throw new PaymentExecutionError('AMOUNT_OUT_OF_RANGE');
  }
  return next;
}
