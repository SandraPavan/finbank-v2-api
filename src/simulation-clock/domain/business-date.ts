// Data de negócio simulada: `YYYY-MM-DD` do calendário, sem hora nem fuso, nunca convertida implicitamente.

/** Fuso em que a data de criação do workspace vira a data inicial do relógio, e em que as datas são apresentadas. */
export const CLOCK_TIME_ZONE = 'America/Sao_Paulo';

/** Faixa aceita, nos dois sentidos e sem limite de passo (D2). */
export const MIN_BUSINESS_DATE = '2000-01-01';
export const MAX_BUSINESS_DATE = '2099-12-31';

declare const brand: unique symbol;
/** Data validada; comparável como texto porque o formato tem largura fixa. */
export type BusinessDate = string & { readonly [brand]: 'BusinessDate' };

/** Recusada pelas regras: inexistente no calendário, fora do formato ou fora da faixa. Sem eco do valor. */
export class InvalidBusinessDateError extends Error {
  constructor() {
    super(`Data simulada inválida: use YYYY-MM-DD entre ${MIN_BUSINESS_DATE} e ${MAX_BUSINESS_DATE}.`);
    this.name = 'InvalidBusinessDateError';
  }
}

const FORMAT = /^(\d{4})-(\d{2})-(\d{2})$/;

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** Aceita somente texto `YYYY-MM-DD` de uma data real dentro da faixa. */
export function parseBusinessDate(raw: string): BusinessDate {
  const match = FORMAT.exec(raw);
  if (match === null) {
    throw new InvalidBusinessDateError();
  }
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new InvalidBusinessDateError();
  }
  if (raw < MIN_BUSINESS_DATE || raw > MAX_BUSINESS_DATE) {
    throw new InvalidBusinessDateError();
  }
  return raw as BusinessDate;
}
