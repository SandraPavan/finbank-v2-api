import { AuthenticationError, RateLimitedError } from '../domain/errors.js';
import type { LoginLimits } from '../domain/login-limits.js';

export interface AttemptStore {
  /** Segundos restantes de restrição (mínimo 1), ou null se não há restrição. */
  restrictionSeconds(subject: string): Promise<number | null>;
  registerFailure(subject: string, limits: LoginLimits): Promise<void>;
  clear(subject: string): Promise<void>;
}

/** Espera máxima por assunto na mesma instância; o excedente é recusado. */
export const MAX_QUEUED_ATTEMPTS = 50;

/**
 * Limita falhas por assunto. Tentativas do mesmo assunto passam uma a uma nesta instância: falhas
 * concorrentes não excedem o limite e logins corretos paralelos não são confundidos com falhas.
 */
export class AttemptLimiter {
  private readonly queues = new Map<string, { size: number; tail: Promise<void> }>();

  constructor(
    private readonly store: AttemptStore,
    private readonly limits: LoginLimits,
  ) {}

  async run<T>(subject: string, attempt: () => Promise<T>): Promise<T> {
    const queue = this.queues.get(subject) ?? { size: 0, tail: Promise.resolve() };
    if (queue.size > MAX_QUEUED_ATTEMPTS) {
      throw new RateLimitedError(1);
    }
    queue.size += 1;
    this.queues.set(subject, queue);
    const result = queue.tail.then(() => this.attempt(subject, attempt));
    queue.tail = result.then(
      () => undefined,
      () => undefined,
    );
    try {
      return await result;
    } finally {
      queue.size -= 1;
      if (queue.size === 0) {
        this.queues.delete(subject);
      }
    }
  }

  private async attempt<T>(subject: string, attempt: () => Promise<T>): Promise<T> {
    const seconds = await this.store.restrictionSeconds(subject);
    if (seconds !== null) {
      throw new RateLimitedError(seconds);
    }
    let value: T;
    try {
      value = await attempt();
    } catch (error) {
      if (error instanceof AuthenticationError && error.code === 'INVALID_CREDENTIALS') {
        await this.store.registerFailure(subject, this.limits);
      }
      throw error;
    }
    await this.store.clear(subject);
    return value;
  }
}
