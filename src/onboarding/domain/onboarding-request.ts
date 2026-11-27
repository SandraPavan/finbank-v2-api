// Dados cadastrais da solicitação de abertura: somente pessoas fictícias. Mensagens e erros nunca repetem valores.
import { normalizeEmail } from '../../identity/domain/email.js';
import { isAcceptablePassword } from '../../authentication/domain/password-policy.js';

/** Campos do pedido, na ordem do contrato. */
export const ONBOARDING_FIELDS = ['alias', 'enrollmentCode', 'name', 'cpf', 'birthDate', 'email', 'phone', 'password'] as const;
export type OnboardingField = (typeof ONBOARDING_FIELDS)[number];

/** Campos recusados pelo formato (400). Só os nomes dos campos, nunca os valores. */
export class OnboardingValidationError extends Error {
  constructor(readonly fields: readonly OnboardingField[]) {
    super(`Solicitação inválida: ${fields.join(', ')}.`);
    this.name = 'OnboardingValidationError';
  }
}

export const MIN_BIRTH_DATE = '1900-01-01';
export const ADULT_AGE = 18;

const CONTROL = /\p{Cc}/u;
const LONE_SURROGATE = /\p{Surrogate}/u;

/** Sem espaços nas pontas nem repetidos; 2 a 120 pontos de código; sem caracteres de controle. */
export function normalizeName(raw: string): string | null {
  if (raw.length > 480 || CONTROL.test(raw) || LONE_SURROGATE.test(raw)) {
    return null;
  }
  const name = raw.trim().replace(/\s+/gu, ' ');
  const length = [...name].length;
  return length >= 2 && length <= 120 ? name : null;
}

/** Com ou sem máscara (pontos e hífen); 11 dígitos, verificadores corretos e não todos iguais. */
export function normalizeCpf(raw: string): string | null {
  if (!/^(\d{11}|\d{3}\.\d{3}\.\d{3}-\d{2})$/.test(raw)) {
    return null;
  }
  const cpf = raw.replace(/[.-]/g, '');
  if (/^(\d)\1{10}$/.test(cpf)) {
    return null;
  }
  const digits = [...cpf].map(Number);
  const check = (length: number): number => {
    const sum = digits.slice(0, length).reduce((total, digit, i) => total + digit * (length + 1 - i), 0);
    const rest = (sum * 10) % 11;
    return rest === 10 ? 0 : rest;
  };
  return check(9) === digits[9] && check(10) === digits[10] ? cpf : null;
}

/** `+55` opcional, DDD de dois dígitos sem zero, 10 ou 11 dígitos; com 11, o número começa por 9. */
export function normalizePhone(raw: string): string | null {
  if (!/^\+?[\d ()-]{10,20}$/.test(raw)) {
    return null;
  }
  let digits = raw.replace(/[ ()-]/g, '');
  if (digits.startsWith('+')) {
    if (!digits.startsWith('+55')) {
      return null;
    }
    digits = digits.slice(3);
  }
  return /^[1-9]{2}(\d{8}|9\d{8})$/.test(digits) ? digits : null;
}

function isLeap(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** Data `YYYY-MM-DD` real a partir de 1900-01-01; null fora disso. Sem `Date` nem fuso. */
export function parseBirthDate(raw: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (match === null) {
    return null;
  }
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const days = month === 2 ? (isLeap(year) ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
  if (month < 1 || month > 12 || day < 1 || day > days || raw < MIN_BIRTH_DATE) {
    return null;
  }
  return raw;
}

/**
 * Idade completa em `on` (ambas `YYYY-MM-DD` válidas). Quem nasceu em 29 de fevereiro completa a idade
 * em 1º de março nos anos não bissextos (Código Civil, art. 132, §3º).
 */
export function ageOn(birth: string, on: string): number {
  const [birthYear, onYear] = [Number(birth.slice(0, 4)), Number(on.slice(0, 4))];
  const birthday = birth.slice(5) === '02-29' && !isLeap(onYear) ? '03-01' : birth.slice(5);
  return onYear - birthYear - (on.slice(5) < birthday ? 1 : 0);
}

/** Pedido com todos os campos no formato aceito. A senha segue em claro só até o hash. */
export interface OnboardingDraft {
  readonly alias: string;
  readonly enrollmentCode: string | null;
  readonly name: string;
  readonly cpf: string;
  readonly birthDate: string;
  readonly email: string;
  readonly phone: string;
  readonly password: string;
}

const ALIAS = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

/**
 * Corpo com exatamente os campos do contrato, todos texto (`enrollmentCode` opcional ou null).
 * Reúne todos os campos recusados num único erro.
 */
export function parseOnboardingRequest(body: unknown): OnboardingDraft {
  if (typeof body !== 'object' || body === null || Array.isArray(body) || Object.getPrototypeOf(body) !== Object.prototype) {
    throw new OnboardingValidationError([...ONBOARDING_FIELDS]);
  }
  const record = body as Record<string, unknown>;
  const unknownKeys = Object.keys(record).filter((key) => !(ONBOARDING_FIELDS as readonly string[]).includes(key));
  const text = (field: OnboardingField): string | null => {
    const value = record[field];
    return typeof value === 'string' ? value : null;
  };
  const wrong: OnboardingField[] = [];
  const take = <T>(field: OnboardingField, parse: (raw: string) => T | null): T => {
    const raw = text(field);
    const value = raw === null ? null : parse(raw);
    if (value === null) {
      wrong.push(field);
    }
    return value as T;
  };

  const alias = take('alias', (raw) => (ALIAS.test(raw) ? raw : null));
  const code = record['enrollmentCode'];
  if (code !== undefined && code !== null && (typeof code !== 'string' || code.length > 32)) {
    wrong.push('enrollmentCode');
  }
  const name = take('name', normalizeName);
  const cpf = take('cpf', normalizeCpf);
  const birthDate = take('birthDate', parseBirthDate);
  const email = take('email', (raw) => {
    try {
      return normalizeEmail(raw);
    } catch {
      return null;
    }
  });
  const phone = take('phone', normalizePhone);
  const password = take('password', (raw) => (isAcceptablePassword(raw) ? raw : null));
  if (wrong.length > 0) {
    throw new OnboardingValidationError(ONBOARDING_FIELDS.filter((field) => wrong.includes(field)));
  }
  if (unknownKeys.length > 0) {
    throw new OnboardingValidationError([]);
  }
  return Object.freeze({ alias, enrollmentCode: typeof code === 'string' && code !== '' ? code : null, name, cpf, birthDate, email, phone, password });
}
