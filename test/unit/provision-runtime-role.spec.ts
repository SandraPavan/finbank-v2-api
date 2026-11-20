// Provisionamento do usuário de execução: validação, verificador SCRAM e SQL gerado (sem banco).
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  parseProvisionEnv,
  ProvisionError,
  provisionSql,
  RUNTIME_GROUP_ROLE,
  scramVerifier,
} from '../../scripts/provision-runtime-role.mjs';

// Gerada a cada execução: nenhum valor parecido com segredo fica no repositório.
const PASSWORD = randomBytes(12).toString('hex');

function rejection(fn: () => unknown): ProvisionError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ProvisionError);
    return error as ProvisionError;
  }
  throw new Error('esperava rejeição');
}

describe('parseProvisionEnv', () => {
  it('aceita usuário e senha válidos', () => {
    expect(parseProvisionEnv({ RUNTIME_DB_USER: 'finbank_app', RUNTIME_DB_PASSWORD: PASSWORD })).toEqual({
      user: 'finbank_app',
      password: PASSWORD,
    });
  });

  it.each([
    ['ausente', undefined],
    ['curto', 'ab'],
    ['maiúsculo', 'Finbank_app'],
    ['com hífen', 'finbank-app'],
    ['com aspas', 'app"; DROP'],
    ['começando por dígito', '1app'],
    ['papel de grupo', RUNTIME_GROUP_ROLE],
    ['reservado', 'pg_app'],
  ])('rejeita usuário %s', (_label, user) => {
    expect(() => parseProvisionEnv({ RUNTIME_DB_USER: user, RUNTIME_DB_PASSWORD: PASSWORD })).toThrow(ProvisionError);
  });

  it.each([
    ['ausente', undefined],
    ['curta', 'curta-demais'],
    ['com aspas', "senha'com-aspas-123456"],
    ['com espaço', 'senha com espaço 123456'],
    ['com cifrão', 'senha$com$cifrao$123456'],
    ['com acento', 'senhaçãoacentuada123456'],
  ])('rejeita senha %s sem repetir o valor', (_label, password) => {
    const error = rejection(() => parseProvisionEnv({ RUNTIME_DB_USER: 'finbank_app', RUNTIME_DB_PASSWORD: password }));
    if (password !== undefined) {
      expect(error.message).not.toContain(password);
    }
  });
});

describe('scramVerifier', () => {
  // Vetor da RFC 7677 (SCRAM-SHA-256): usuário "user", senha "pencil".
  const salt = Buffer.from('W22ZaJ0SNY7soEsUEjb6gQ==', 'base64');
  const authMessage =
    'n=user,r=rOprNGfwEbeRWgbNEkqO,' +
    'r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096,' +
    'c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0';
  const clientProof = Buffer.from('dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=', 'base64');
  const serverSignature = '6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=';

  function parts(verifier: string): { storedKey: Buffer; serverKey: Buffer; iterations: string; salt: string } {
    const match = /^SCRAM-SHA-256\$(\d+):([^$]+)\$([^:]+):(.+)$/.exec(verifier);
    expect(match).not.toBeNull();
    const [, iterations, saltB64, stored, server] = match as unknown as [string, string, string, string, string];
    return {
      iterations,
      salt: saltB64,
      storedKey: Buffer.from(stored, 'base64'),
      serverKey: Buffer.from(server, 'base64'),
    };
  }

  it('reproduz a assinatura do servidor e valida a prova do cliente da RFC 7677', () => {
    const { storedKey, serverKey, iterations, salt: saltB64 } = parts(scramVerifier('pencil', salt, 4096));
    expect(iterations).toBe('4096');
    expect(saltB64).toBe('W22ZaJ0SNY7soEsUEjb6gQ==');
    expect(createHmac('sha256', serverKey).update(authMessage).digest('base64')).toBe(serverSignature);
    // ClientKey = ClientProof XOR HMAC(StoredKey, AuthMessage); SHA-256(ClientKey) deve ser StoredKey.
    const clientSignature = createHmac('sha256', storedKey).update(authMessage).digest();
    const clientKey = Buffer.from(clientProof.map((byte, i) => byte ^ (clientSignature[i] ?? 0)));
    expect(createHash('sha256').update(clientKey).digest().equals(storedKey)).toBe(true);
  });

  it('usa sal aleatório de 16 bytes e 4096 iterações por padrão', () => {
    const a = parts(scramVerifier(PASSWORD));
    const b = parts(scramVerifier(PASSWORD));
    expect(a.iterations).toBe('4096');
    expect(Buffer.from(a.salt, 'base64')).toHaveLength(16);
    expect(a.salt).not.toBe(b.salt);
  });
});

describe('provisionSql', () => {
  it('cria ou atualiza o usuário com o verificador, sem a senha em texto', () => {
    const verifier = scramVerifier(PASSWORD);
    const sql = provisionSql('finbank_app', verifier);
    expect(sql).not.toContain(PASSWORD);
    expect(sql).toContain(`CREATE ROLE "finbank_app" LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${verifier}'`);
    expect(sql).toContain(`ALTER ROLE "finbank_app" LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${verifier}'`);
    expect(sql).toContain(`GRANT "${RUNTIME_GROUP_ROLE}" TO "finbank_app";`);
    expect(sql).toContain("IF current_user = 'finbank_app' THEN");
    expect(sql).toMatch(/ELSIF existing\.rolsuper OR existing\.rolcreaterole/);
  });

  it('só reaproveita papel existente sem outros vínculos, sem posse e sem privilégios diretos', () => {
    const sql = provisionSql('finbank_app', scramVerifier(PASSWORD));
    expect(sql).toContain(`g.rolname <> '${RUNTIME_GROUP_ROLE}'`);
    expect(sql).toContain('pertence a outros papéis');
    for (const owner of ['relowner', 'nspowner', 'proowner', 'typowner', 'datdba']) {
      expect(sql).toContain(`${owner} = existing.oid`);
    }
    expect(sql).toContain('é dono de objetos');
    for (const acl of ['relacl', 'attacl', 'nspacl', 'proacl', 'datacl']) {
      expect(sql).toContain(`aclexplode(`);
      expect(sql).toMatch(new RegExp(`aclexplode\\(\\w+\\.${acl}\\)`));
    }
    expect(sql).toContain('tem privilégios diretos');
  });

  it('recusa identificador ou verificador fora do formato', () => {
    const verifier = scramVerifier(PASSWORD);
    expect(() => provisionSql('app"; DROP ROLE x; --', verifier)).toThrow(ProvisionError);
    expect(() => provisionSql('finbank_app', `${verifier}'; DROP ROLE x; --`)).toThrow(ProvisionError);
    expect(() => provisionSql('finbank_app', PASSWORD)).toThrow(ProvisionError);
  });
});
