// Extrato da conta: consulta paginada por cursor e apresentação dos lançamentos. Puro: sem relógio, rede ou logs.
import { formatAmount } from './educational-credit.js';

export const STATEMENT_DEFAULT_LIMIT = 20;
export const STATEMENT_MAX_LIMIT = 100;

/** Parâmetros recusados pelo formato (400), sem valores. */
export class InvalidStatementQueryError extends Error {
  constructor(readonly fields: readonly string[]) {
    super(`Consulta de extrato inválida: ${fields.join(', ')}.`);
    this.name = 'InvalidStatementQueryError';
  }
}

/** Posição de continuação: o último lançamento já entregue. */
export interface StatementPosition {
  readonly occurredAt: Date;
  readonly entryId: string;
}

export interface StatementQuery {
  readonly limit: number;
  readonly after: StatementPosition | null;
}

export type StatementType = 'EDUCATIONAL_CREDIT' | 'TRANSFER' | 'REVERSAL';
export type StatementModality = 'PIX_KEY' | 'PIX_COPY_PASTE' | 'PIX_QR_STATIC';

/** Lançamento como lido do ledger: valor com sinal. */
export interface LedgerLine {
  readonly entryId: string;
  readonly operationId: string;
  readonly type: string;
  readonly modality: string | null;
  readonly amountCents: bigint;
  readonly reversesOperationId: string | null;
  readonly occurredAt: Date;
}

export interface StatementItem {
  readonly entryId: string;
  readonly operationId: string;
  readonly type: StatementType;
  readonly modality: StatementModality | null;
  readonly direction: 'CREDIT' | 'DEBIT';
  readonly amount: string;
  /** O ledger só guarda o que foi concluído. */
  readonly status: 'COMPLETED';
  readonly reversesOperationId: string | null;
  readonly occurredAt: string;
}

/** Valor lido fora do conjunto conhecido: dado inconsistente, nunca apresentado. */
export class StatementDataError extends Error {
  constructor() {
    super('Lançamento fora do formato esperado.');
    this.name = 'StatementDataError';
  }
}

const LIMIT = /^(0|[1-9][0-9]{0,2})$/;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
// Opaco para o cliente: versão, instante em milissegundos e identificador do lançamento.
const CURSOR = new RegExp(`^s1\\.(0|[1-9][0-9]{0,15})\\.(${UUID})$`);
const TYPES: readonly StatementType[] = ['EDUCATIONAL_CREDIT', 'TRANSFER', 'REVERSAL'];
const MODALITIES: readonly StatementModality[] = ['PIX_KEY', 'PIX_COPY_PASTE', 'PIX_QR_STATIC'];
// Maior instante representável por Date (±8.64e15 ms).
const MAX_MILLIS = 8_640_000_000_000_000;

export function encodeCursor(position: StatementPosition): string {
  return `s1.${position.occurredAt.getTime()}.${position.entryId}`;
}

export function decodeCursor(raw: string): StatementPosition | null {
  const match = CURSOR.exec(raw);
  if (match === null) {
    return null;
  }
  const millis = Number(match[1]);
  if (!Number.isSafeInteger(millis) || millis > MAX_MILLIS) {
    return null;
  }
  return { occurredAt: new Date(millis), entryId: match[2] ?? '' };
}

/** `limit` e `cursor` estritos: sem coerção, repetição ou parâmetro desconhecido. */
export function parseStatementQuery(query: Readonly<Record<string, unknown>>): StatementQuery {
  const unknown = Object.keys(query).filter((name) => name !== 'limit' && name !== 'cursor');
  if (unknown.length > 0) {
    throw new InvalidStatementQueryError([]);
  }
  let limit = STATEMENT_DEFAULT_LIMIT;
  const rawLimit = query['limit'];
  if (rawLimit !== undefined) {
    const value = typeof rawLimit === 'string' && LIMIT.test(rawLimit) ? Number(rawLimit) : NaN;
    if (!(value >= 1 && value <= STATEMENT_MAX_LIMIT)) {
      throw new InvalidStatementQueryError(['limit']);
    }
    limit = value;
  }
  let after: StatementPosition | null = null;
  const rawCursor = query['cursor'];
  if (rawCursor !== undefined) {
    after = typeof rawCursor === 'string' ? decodeCursor(rawCursor) : null;
    if (after === null) {
      throw new InvalidStatementQueryError(['cursor']);
    }
  }
  return { limit, after };
}

/** Lançamento para apresentação: direção pelo sinal e valor sempre positivo, sem perda de precisão. */
export function toStatementItem(line: LedgerLine): StatementItem {
  const type = TYPES.find((known) => known === line.type);
  const modality = line.modality === null ? null : MODALITIES.find((known) => known === line.modality);
  if (type === undefined || modality === undefined || line.amountCents === 0n) {
    throw new StatementDataError();
  }
  const credit = line.amountCents > 0n;
  return {
    entryId: line.entryId,
    operationId: line.operationId,
    type,
    modality,
    direction: credit ? 'CREDIT' : 'DEBIT',
    amount: formatAmount(credit ? line.amountCents : -line.amountCents),
    status: 'COMPLETED',
    reversesOperationId: line.reversesOperationId,
    occurredAt: line.occurredAt.toISOString(),
  };
}
