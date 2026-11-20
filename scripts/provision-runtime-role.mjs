// Provisiona o usuário de login de execução da API (DEV-012). Sem dependências: roda no estágio de
// migração da imagem e no setup dos testes. Executar depois de `prisma migrate deploy`, conectado
// como dono do esquema (DATABASE_URL). A senha nunca é enviada ao banco: vai só o verificador SCRAM.
import { spawnSync } from 'node:child_process';
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RUNTIME_GROUP_ROLE = 'finbank_runtime';
export const SCRAM_ITERATIONS = 4096;
export const ROLE_NAME_PATTERN = /^[a-z_][a-z0-9_]{2,62}$/;
export const PASSWORD_PATTERN = /^[A-Za-z0-9_.-]{16,128}$/;
const VERIFIER_PATTERN = /^SCRAM-SHA-256\$[0-9]+:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/;

export class ProvisionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProvisionError';
  }
}

/** Valida as variáveis de ambiente. As mensagens nunca repetem os valores recebidos. */
export function parseProvisionEnv(env) {
  const user = env.RUNTIME_DB_USER;
  const password = env.RUNTIME_DB_PASSWORD;
  if (typeof user !== 'string' || !ROLE_NAME_PATTERN.test(user)) {
    throw new ProvisionError(
      'RUNTIME_DB_USER deve ter de 3 a 63 caracteres a-z, 0-9 ou sublinhado, começando por letra ou sublinhado',
    );
  }
  if (user === RUNTIME_GROUP_ROLE || user.startsWith('pg_')) {
    throw new ProvisionError('RUNTIME_DB_USER não pode ser o papel de grupo nem um papel reservado');
  }
  if (typeof password !== 'string' || !PASSWORD_PATTERN.test(password)) {
    throw new ProvisionError('RUNTIME_DB_PASSWORD deve ter de 16 a 128 caracteres A-Z, a-z, 0-9, ".", "-" ou "_"');
  }
  return { user, password };
}

/**
 * Verificador SCRAM-SHA-256 no formato do PostgreSQL (RFC 5802/7677):
 * SCRAM-SHA-256$<iterações>:<sal>$<StoredKey>:<ServerKey>, em base64.
 * As senhas aceitas são ASCII imprimível sem espaços, para as quais o SASLprep não altera nada.
 */
export function scramVerifier(password, salt = randomBytes(16), iterations = SCRAM_ITERATIONS) {
  const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return [
    'SCRAM-SHA-256',
    `${iterations}:${salt.toString('base64')}`,
    `${storedKey.toString('base64')}:${serverKey.toString('base64')}`,
  ].join('$');
}

/** SQL idempotente: cria ou atualiza o usuário de login e o torna membro do papel de grupo. */
export function provisionSql(user, verifier) {
  if (!ROLE_NAME_PATTERN.test(user) || !VERIFIER_PATTERN.test(verifier)) {
    throw new ProvisionError('parâmetros de provisionamento inválidos');
  }
  const attributes = 'LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS';
  const tag = '$provision$';
  return [
    `DO ${tag}`,
    'DECLARE',
    '  existing RECORD;',
    'BEGIN',
    `  IF current_user = '${user}' THEN`,
    "    RAISE EXCEPTION 'o usuário de execução deve ser diferente do dono do esquema';",
    '  END IF;',
    '  SELECT oid, rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls INTO existing',
    `    FROM pg_roles WHERE rolname = '${user}';`,
    '  IF NOT FOUND THEN',
    `    CREATE ROLE "${user}" ${attributes} PASSWORD '${verifier}';`,
    '  ELSIF existing.rolsuper OR existing.rolcreaterole OR existing.rolcreatedb',
    '        OR existing.rolreplication OR existing.rolbypassrls THEN',
    "    RAISE EXCEPTION 'o papel indicado para execução já tem atributos administrativos';",
    // Um papel existente só é reaproveitado se tiver exatamente o que a execução recebe:
    // nenhum vínculo além do papel de grupo, nenhuma posse e nenhum privilégio direto.
    '  ELSIF EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid',
    `                 WHERE m.member = existing.oid AND g.rolname <> '${RUNTIME_GROUP_ROLE}') THEN`,
    "    RAISE EXCEPTION 'o papel indicado para execução pertence a outros papéis';",
    '  ELSIF EXISTS (SELECT 1 FROM pg_class WHERE relowner = existing.oid)',
    '        OR EXISTS (SELECT 1 FROM pg_namespace WHERE nspowner = existing.oid)',
    '        OR EXISTS (SELECT 1 FROM pg_proc WHERE proowner = existing.oid)',
    '        OR EXISTS (SELECT 1 FROM pg_type WHERE typowner = existing.oid)',
    '        OR EXISTS (SELECT 1 FROM pg_database WHERE datdba = existing.oid) THEN',
    "    RAISE EXCEPTION 'o papel indicado para execução é dono de objetos';",
    '  ELSIF EXISTS (SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a WHERE a.grantee = existing.oid)',
    '        OR EXISTS (SELECT 1 FROM pg_attribute t CROSS JOIN LATERAL aclexplode(t.attacl) a WHERE a.grantee = existing.oid)',
    '        OR EXISTS (SELECT 1 FROM pg_namespace n CROSS JOIN LATERAL aclexplode(n.nspacl) a WHERE a.grantee = existing.oid)',
    '        OR EXISTS (SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a WHERE a.grantee = existing.oid)',
    '        OR EXISTS (SELECT 1 FROM pg_database d CROSS JOIN LATERAL aclexplode(d.datacl) a WHERE a.grantee = existing.oid) THEN',
    "    RAISE EXCEPTION 'o papel indicado para execução tem privilégios diretos';",
    '  ELSE',
    `    ALTER ROLE "${user}" ${attributes} PASSWORD '${verifier}';`,
    '  END IF;',
    'END',
    `${tag};`,
    `GRANT "${RUNTIME_GROUP_ROLE}" TO "${user}";`,
    '',
  ].join('\n');
}

/** Executa o provisionamento com `prisma db execute --stdin` (DATABASE_URL do dono). */
export function provision(env, cwd = process.cwd()) {
  const { user, password } = parseProvisionEnv(env);
  const sql = provisionSql(user, scramVerifier(password));
  const prisma = resolve(cwd, 'node_modules/.bin/prisma');
  const result = spawnSync(prisma, ['db', 'execute', '--stdin'], {
    cwd,
    env: { ...process.env, ...env },
    input: sql,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    // A saída do Prisma não contém a senha: o SQL leva só o verificador.
    const detail = (result.stderr || result.stdout || '').trim();
    throw new ProvisionError(`falha ao provisionar o usuário de execução: ${detail}`);
  }
  return user;
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  try {
    const user = provision(process.env);
    process.stdout.write(`usuário de execução provisionado: ${user}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof ProvisionError ? error.message : 'falha inesperada no provisionamento'}\n`);
    process.exit(1);
  }
}
