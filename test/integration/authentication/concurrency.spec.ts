// Disputas reais entre login, troca de senha, encerramento geral e desativação.
// Um trigger de teste pausa a transação que insere a sessão até o dono liberar uma trava consultiva.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { settle } from '../payment-execution/support.js';
import { type AuthHarness, authHarness, failure, OTHER_PASSWORD, PASSWORD, type Person } from './support.js';

const LOCK = 160_016;

describe('concorrência da autenticação', () => {
  let h: AuthHarness;

  beforeAll(async () => {
    h = await authHarness();
    await h.db.client.$executeRawUnsafe(`CREATE FUNCTION test_pause_session() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      PERFORM pg_advisory_xact_lock_shared(${LOCK}); RETURN NEW; END $$`);
    await h.db.client.$executeRawUnsafe('CREATE TRIGGER test_pause_session AFTER INSERT ON "user_session" FOR EACH ROW EXECUTE FUNCTION test_pause_session()');
  });

  afterAll(async () => {
    await h?.db.client.$executeRawUnsafe('DROP TRIGGER IF EXISTS test_pause_session ON "user_session"');
    await h?.db.client.$executeRawUnsafe('DROP FUNCTION IF EXISTS test_pause_session()');
    await h?.close();
  });

  /** Espera até haver exatamente `n` conexões paradas em trava. */
  async function waitBlocked(n: number): Promise<void> {
    for (let i = 0; i < 400; i += 1) {
      const [row] = await h.db.client.$queryRaw<{ total: number }[]>`
        SELECT count(*)::int AS "total" FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
      if (row?.total === n) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`esperava ${n} conexões em trava`);
  }

  /** `first` fica pausada com a sessão inserida e não confirmada; `second` só começa depois. */
  async function interleave<A, B>(first: () => Promise<A>, second: () => Promise<B>) {
    let started: [Promise<PromiseSettledResult<A>[]>, Promise<PromiseSettledResult<B>[]>] | undefined;
    await h.db.client.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK}::bigint)`;
        const a = Promise.allSettled([first()]);
        await waitBlocked(1);
        const b = Promise.allSettled([second()]);
        await waitBlocked(2);
        started = [a, b];
      },
      { timeout: 20_000 },
    );
    const [[a], [b]] = await Promise.all(started as NonNullable<typeof started>);
    return { a: a as PromiseSettledResult<A>, b: b as PromiseSettledResult<B> };
  }

  function value<T>(result: PromiseSettledResult<T>): T {
    if (result.status === 'rejected') {
      throw result.reason as Error;
    }
    return result.value;
  }

  const disable = (person: Person) => h.db.client.userIdentity.update({ where: { id: person.id }, data: { status: 'DISABLED' } });

  it('login antes da desativação: a sessão nasce e é encerrada', async () => {
    const person = await h.customer();
    const { a, b } = await interleave(() => h.login(person), () => disable(person));
    value(b);
    await failure(h.auth.validate(value(a).secret), 'SESSION_INVALID');
    expect(await h.activeCount(person.id)).toBe(0);
  });

  it('desativação antes do login: nenhuma sessão nasce', async () => {
    const person = await h.customer();
    let login: Promise<PromiseSettledResult<unknown>[]> | undefined;
    await h.db.client.$transaction(
      async (tx) => {
        await tx.userIdentity.update({ where: { id: person.id }, data: { status: 'DISABLED' } });
        login = Promise.allSettled([h.login(person)]);
        await waitBlocked(1);
      },
      { timeout: 20_000 },
    );
    const [result] = (await login) ?? [];
    expect(result).toMatchObject({ status: 'rejected', reason: { code: 'INVALID_CREDENTIALS' } });
    expect(await h.db.client.userSession.count({ where: { identityId: person.id } })).toBe(0);
  });

  it('login com a senha antiga antes da troca: a sessão dele é encerrada', async () => {
    const person = await h.customer();
    const current = await h.login(person);
    const { a, b } = await interleave(() => h.login(person), () => h.auth.changePassword(current.secret, PASSWORD, OTHER_PASSWORD));
    await failure(h.auth.validate(value(a).secret), 'SESSION_INVALID');
    await h.auth.validate(value(b).secret);
    expect(await h.activeCount(person.id)).toBe(1);
  });

  it('troca antes do login com a senha antiga: o login é recusado', async () => {
    const person = await h.customer();
    const current = await h.login(person);
    const { a, b } = await interleave(() => h.auth.changePassword(current.secret, PASSWORD, OTHER_PASSWORD), () => h.login(person));
    await h.auth.validate(value(a).secret);
    expect(b).toMatchObject({ status: 'rejected', reason: { code: 'INVALID_CREDENTIALS' } });
    expect(await h.activeCount(person.id)).toBe(1);
  });

  it('login antes do encerramento geral: a sessão dele também é encerrada', async () => {
    const person = await h.customer();
    const current = await h.login(person);
    const { a, b } = await interleave(() => h.login(person), () => h.auth.logoutAll(current.secret));
    value(b);
    await failure(h.auth.validate(value(a).secret), 'SESSION_INVALID');
    expect(await h.activeCount(person.id)).toBe(0);
  });

  it('encerramento geral atrás de uma troca não derruba a sessão nova', async () => {
    const person = await h.customer();
    const current = await h.login(person);
    const { a, b } = await interleave(
      () => h.auth.changePassword(current.secret, PASSWORD, OTHER_PASSWORD),
      () => h.auth.logoutAll(current.secret),
    );
    await h.auth.validate(value(a).secret);
    expect(b).toMatchObject({ status: 'rejected', reason: { code: 'SESSION_INVALID' } });
  });

  it('trocas simultâneas: uma única vence e resta uma sessão', async () => {
    const person = await h.customer();
    const sessions = await Promise.all(Array.from({ length: 6 }, () => h.login(person)));
    const { ok, errors } = await settle(
      sessions.map(({ secret }, i) => h.auth.changePassword(secret, PASSWORD, `${OTHER_PASSWORD} ${i}`)),
    );
    expect(ok).toHaveLength(1);
    expect(errors).toHaveLength(5);
    for (const error of errors) {
      expect(error).toMatchObject({ code: expect.stringMatching(/^(SESSION_INVALID|INVALID_CREDENTIALS)$/) as string });
    }
    expect(await h.activeCount(person.id)).toBe(1);
    await h.auth.validate(ok[0]?.secret);
  });

  it('rodadas paralelas de login e desativação nunca deixam sessão aberta', async () => {
    for (let round = 0; round < 10; round += 1) {
      const person = await h.customer();
      const { errors } = await settle<unknown>([h.login(person), h.login(person), disable(person), h.login(person)]);
      for (const error of errors) {
        expect(error).toMatchObject({ code: 'INVALID_CREDENTIALS' });
      }
      expect(await h.activeCount(person.id)).toBe(0);
    }
  });

  it('validações e encerramento paralelos: depois do logout nada valida', async () => {
    const person = await h.customer();
    const { secret } = await h.login(person);
    const { errors } = await settle<unknown>([...Array.from({ length: 8 }, () => h.auth.validate(secret)), h.auth.logout(secret)]);
    for (const error of errors) {
      expect(error).toMatchObject({ code: 'SESSION_INVALID' });
    }
    await failure(h.auth.validate(secret), 'SESSION_INVALID');
  });
});
