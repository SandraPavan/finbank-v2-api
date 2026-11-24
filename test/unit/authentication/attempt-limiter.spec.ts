import { describe, expect, it, vi } from 'vitest';
import { AttemptLimiter, MAX_QUEUED_ATTEMPTS } from '../../../src/authentication/application/attempt-limiter.js';
import { AuthenticationError, RateLimitedError } from '../../../src/authentication/domain/errors.js';
import { csrfMatches, csrfToken } from '../../../src/authentication/http/csrf.js';

const LIMITS = { maxAttempts: 5, windowMinutes: 15, restrictionSeconds: 30, maxRestrictionSeconds: 900 };

function setup(restriction: number | null = null) {
  const store = {
    restrictionSeconds: vi.fn(() => Promise.resolve(restriction)),
    registerFailure: vi.fn(() => Promise.resolve()),
    clear: vi.fn(() => Promise.resolve()),
  };
  return { store, limiter: new AttemptLimiter(store, LIMITS) };
}

describe('AttemptLimiter', () => {
  it('sucesso zera; credencial inválida conta; outros erros não contam nem zeram', async () => {
    const { store, limiter } = setup();
    expect(await limiter.run('a', () => Promise.resolve(1))).toBe(1);
    expect(store.clear).toHaveBeenCalledExactlyOnceWith('a');
    await expect(limiter.run('a', () => Promise.reject(new AuthenticationError('INVALID_CREDENTIALS')))).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    expect(store.registerFailure).toHaveBeenCalledExactlyOnceWith('a', LIMITS);
    for (const error of [new AuthenticationError('AUTHENTICATION_FAILED'), new AuthenticationError('PASSWORD_POLICY'), new Error('x')]) {
      await expect(limiter.run('a', () => Promise.reject(error))).rejects.toBe(error);
    }
    expect(store.registerFailure).toHaveBeenCalledTimes(1);
    expect(store.clear).toHaveBeenCalledTimes(1);
  });

  it('com restrição não executa a tentativa', async () => {
    const { limiter } = setup(17);
    const attempt = vi.fn(() => Promise.resolve(1));
    await expect(limiter.run('a', attempt)).rejects.toMatchObject({ code: 'RATE_LIMITED', retryAfterSeconds: 17 });
    expect(attempt).not.toHaveBeenCalled();
  });

  it('se não consegue consultar ou registrar, nega', async () => {
    const { store, limiter } = setup();
    const down = new AuthenticationError('AUTHENTICATION_FAILED');
    store.restrictionSeconds.mockRejectedValueOnce(down);
    const attempt = vi.fn(() => Promise.resolve(1));
    await expect(limiter.run('a', attempt)).rejects.toBe(down);
    expect(attempt).not.toHaveBeenCalled();
    store.registerFailure.mockRejectedValueOnce(down);
    await expect(limiter.run('a', () => Promise.reject(new AuthenticationError('INVALID_CREDENTIALS')))).rejects.toBe(down);
  });

  it('serializa por assunto, recusa o excedente da fila e não bloqueia outros assuntos', async () => {
    const { limiter } = setup();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let running = 0;
    let peak = 0;
    const attempt = async () => {
      running += 1;
      peak = Math.max(peak, running);
      await gate;
      running -= 1;
    };
    const queued = Array.from({ length: MAX_QUEUED_ATTEMPTS + 1 }, () => limiter.run('a', attempt));
    await expect(limiter.run('a', attempt)).rejects.toBeInstanceOf(RateLimitedError);
    expect(await limiter.run('b', () => Promise.resolve('livre'))).toBe('livre');
    release();
    await Promise.all(queued);
    expect(peak).toBe(1);
    expect(await limiter.run('a', () => Promise.resolve('vazia'))).toBe('vazia');
  });

  it('uma falha não quebra a fila', async () => {
    const { limiter } = setup();
    const results = await Promise.allSettled([
      limiter.run('a', () => Promise.reject(new Error('x'))),
      limiter.run('a', () => Promise.resolve(2)),
    ]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'fulfilled']);
  });
});

describe('token CSRF', () => {
  it('depende do contexto e só o exato confere', () => {
    const [a, b] = ['a'.repeat(43), 'b'.repeat(43)];
    expect(csrfToken(a)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(csrfToken(a)).toBe(csrfToken(a));
    expect(csrfToken(a)).not.toBe(csrfToken(b));
    expect(csrfMatches(a, csrfToken(a))).toBe(true);
    for (const wrong of [undefined, '', a, csrfToken(b), `${csrfToken(a)} `, csrfToken(a).slice(1)]) {
      expect(csrfMatches(a, wrong)).toBe(false);
    }
  });
});
