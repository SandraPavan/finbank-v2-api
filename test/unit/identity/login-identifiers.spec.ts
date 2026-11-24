import { describe, expect, it } from 'vitest';
import { normalizeEmail } from '../../../src/identity/domain/email.js';
import { IdentityError } from '../../../src/identity/domain/errors.js';
import { parseWorkspaceAlias } from '../../../src/identity/domain/workspace-alias.js';

function failure(fn: () => unknown): IdentityError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(IdentityError);
    return error as IdentityError;
  }
  throw new Error('esperava rejeição');
}

describe('normalização de e-mail', () => {
  it.each([
    ['ana@example.test', 'ana@example.test'],
    ['  Ana@Example.TEST \n', 'ana@example.test'],
    ['a.n.a+Turma@example.test', 'a.n.a+turma@example.test'],
    ['a@b', 'a@b'],
    [`${'a'.repeat(252)}@b`, `${'a'.repeat(252)}@b`],
    [`  ${'a'.repeat(252)}@b  `, `${'a'.repeat(252)}@b`],
    ['[x]_^`{|}~@y', '[x]_^`{|}~@y'],
  ])('%j → %j, idempotente', (raw, expected) => {
    expect(normalizeEmail(raw)).toBe(expected);
    expect(normalizeEmail(expected)).toBe(expected);
  });

  it.each([
    undefined, null, 1, {}, ['ana@example.test'], '', '   ', 'ana', '@b', 'a@', 'a@b@c', 'a b@c', 'a@b c', 'a\n@b',
    `${'a'.repeat(253)}@b`, 'josé@example.test', 'ana@exämple.test',
    // Sinal de kelvin e I com ponto: virariam (ou gerariam) ASCII ao converter a caixa.
    'K@example.test', 'İ@example.test', 'a\u0000@b', 'a\u007f@b',
  ])('recusa %j sem repetir o valor', (raw) => {
    const error = failure(() => normalizeEmail(raw));
    expect(error.code).toBe('INVALID_EMAIL');
    expect(error.message).toBe('E-mail inválido.');
  });
});

describe('alias do workspace', () => {
  it.each(['abc', 'qa-automacao', '123', 'a--b', 'a'.repeat(40)])('aceita %j', (alias) => {
    expect(parseWorkspaceAlias(alias)).toBe(alias);
  });

  it.each([
    undefined, null, 1, {}, '', 'ab', 'a'.repeat(41), '-abc', 'abc-', 'ABC', 'a_b', 'a b', ' abc', 'abc\n', 'ação', '../etc',
  ])('recusa %j sem repetir o valor', (raw) => {
    const error = failure(() => parseWorkspaceAlias(raw));
    expect(error.code).toBe('INVALID_ALIAS');
    expect(error.message).toBe('Alias de workspace inválido.');
  });
});
