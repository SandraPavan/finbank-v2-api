import { createHash } from 'node:crypto';
import { invalidInput, PaymentExecutionError } from './errors.js';
import { isPlainObject, type Movement, parseOperationKey, parseUuid } from './transfer.js';

export const OPERATION_TYPES = ['TRANSFER', 'REVERSAL', 'EDUCATIONAL_CREDIT'] as const;
/** TRANSFER é a movimentação original; REVERSAL, o estorno total de uma TRANSFER; EDUCATIONAL_CREDIT, o crédito educacional. */
export type OperationType = (typeof OPERATION_TYPES)[number];

const COMMAND_KEYS = ['workspaceId', 'operationKey', 'originalOperationId'] as const;

export interface ReversalCommand {
  readonly workspaceId: string;
  readonly operationKey: string;
  readonly originalOperationId: string;
}

/** Operação registrada, vista pelo estorno: tipo e movimentação. */
export interface OperationToReverse extends Movement {
  readonly type: OperationType;
}

/** Validação estrita do comando de estorno: objeto simples, somente os campos esperados, sem coerção. */
export function parseReversalCommand(raw: unknown): ReversalCommand {
  if (!isPlainObject(raw)) {
    throw invalidInput('comando', 'deve ser um objeto simples');
  }
  if (Object.keys(raw).some((key) => !(COMMAND_KEYS as readonly string[]).includes(key))) {
    throw invalidInput('comando', `aceita somente os campos ${COMMAND_KEYS.join(', ')}`);
  }
  const workspaceId = parseUuid(raw['workspaceId'], 'workspaceId');
  const operationKey = parseOperationKey(raw['operationKey']);
  const originalOperationId = parseUuid(raw['originalOperationId'], 'originalOperationId');
  return Object.freeze({ workspaceId, operationKey, originalOperationId });
}

/**
 * Impressão digital do estorno (versão 2 da forma canônica). Difere sempre da impressão
 * de uma transferência (versão 1), então a mesma chave não serve aos dois tipos.
 */
export function reversalFingerprint(command: ReversalCommand): string {
  const canonical = JSON.stringify({ v: 2, type: 'REVERSAL', originalOperationId: command.originalOperationId });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/** Movimentação do estorno total: contas invertidas e mesmo valor. Só TRANSFER é estornável. */
export function reversalMovement(original: OperationToReverse): Movement {
  if (original.type !== 'TRANSFER') {
    throw new PaymentExecutionError('NOT_REVERSIBLE');
  }
  return Object.freeze({
    debitAccountId: original.creditAccountId,
    creditAccountId: original.debitAccountId,
    amountCents: original.amountCents,
  });
}
