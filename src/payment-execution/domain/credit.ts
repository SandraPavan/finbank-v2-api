import { createHash } from 'node:crypto';
import { invalidInput } from './errors.js';
import { parseAmountCents } from './money.js';
import { isPlainObject, parseOperationKey, parseUuid } from './transfer.js';

const COMMAND_KEYS = ['workspaceId', 'operationKey', 'accountId', 'amountCents', 'ceilingCents'] as const;

/** Crédito educacional: recurso fictício da contrapartida do workspace para uma conta comum. */
export interface CreditCommand {
  readonly workspaceId: string;
  readonly operationKey: string;
  readonly accountId: string;
  readonly amountCents: bigint;
  /**
   * Teto opcional do total de créditos educacionais da conta, incluindo este. É política de quem chama,
   * conferida sob a trava da conta; não entra na impressão digital.
   */
  readonly ceilingCents: bigint | null;
}

/** Validação estrita: objeto simples, somente os campos esperados, sem coerção. */
export function parseCreditCommand(raw: unknown): CreditCommand {
  if (!isPlainObject(raw)) {
    throw invalidInput('comando', 'deve ser um objeto simples');
  }
  if (Object.keys(raw).some((key) => !(COMMAND_KEYS as readonly string[]).includes(key))) {
    throw invalidInput('comando', `aceita somente os campos ${COMMAND_KEYS.join(', ')}`);
  }
  return Object.freeze({
    workspaceId: parseUuid(raw['workspaceId'], 'workspaceId'),
    operationKey: parseOperationKey(raw['operationKey']),
    accountId: parseUuid(raw['accountId'], 'accountId'),
    amountCents: parseAmountCents(raw['amountCents']),
    ceilingCents: raw['ceilingCents'] === undefined ? null : parseCeiling(raw['ceilingCents']),
  });
}

function parseCeiling(raw: unknown): bigint {
  if (typeof raw !== 'bigint' || raw <= 0n) {
    throw invalidInput('ceilingCents', 'deve ser um inteiro positivo em centavos do tipo bigint');
  }
  return raw;
}

/** Versão 3 da forma canônica: nunca coincide com transferência (1 e 4) nem estorno (2). */
export function creditFingerprint(command: CreditCommand): string {
  const canonical = JSON.stringify({ v: 3, type: 'EDUCATIONAL_CREDIT', accountId: command.accountId, amountCents: command.amountCents.toString(10) });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
