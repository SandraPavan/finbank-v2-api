// Linha de comando do operador (DEV-019). Sem HTTP; conecta como dono do esquema (DATABASE_URL).
import { randomUUID } from 'node:crypto';
import { PrismaOperatorStore } from './administration/adapters/prisma-operator.store.js';
import { RandomTemporaryCredential } from './administration/adapters/random-temporary-credential.js';
import { OperatorService } from './administration/application/operator.service.js';
import { parseCommand, USAGE, UsageError } from './administration/cli/arguments.js';
import { readPassword } from './administration/cli/password-input.js';
import { runCommand } from './administration/cli/run-command.js';
import { AdministrationError } from './administration/domain/errors.js';
import { Argon2PasswordHasher } from './authentication/adapters/argon2-password-hasher.js';
import { AuthenticationError } from './authentication/domain/errors.js';
import { InvalidConfigError, loadAppConfig } from './config/app-config.js';
import { IdentityError } from './identity/domain/errors.js';
import { DatabaseUnavailableError } from './persistence/database-errors.js';
import { PrismaService } from './persistence/prisma.service.js';

const EXIT = { failure: 1, usage: 2, conflict: 3 } as const;

async function main(): Promise<void> {
  const command = parseCommand(process.argv.slice(2));
  const { databaseUrl, temporaryCredentialHours } = loadAppConfig({
    DATABASE_URL: process.env['DATABASE_URL'],
    TEMPORARY_CREDENTIAL_HOURS: process.env['TEMPORARY_CREDENTIAL_HOURS'],
  });
  const prisma = new PrismaService({ databaseUrl });
  await prisma.onModuleInit();
  try {
    const service = new OperatorService({
      store: new PrismaOperatorStore(prisma.client),
      hasher: new Argon2PasswordHasher(),
      generator: new RandomTemporaryCredential(),
      temporaryCredentialHours,
      correlationId: randomUUID(),
    });
    const notice = (text: string): void => void process.stderr.write(text);
    const message = await runCommand(service, command, () => readPassword({ input: process.stdin, notice }));
    process.stdout.write(`${message}\n`);
  } finally {
    await prisma.onModuleDestroy();
  }
}

function report(error: unknown): number {
  if (error instanceof UsageError) {
    process.stderr.write(`${error.message}.\n${error.message === new UsageError().message ? `${USAGE}\n` : ''}`);
    return EXIT.usage;
  }
  const policy = error instanceof AuthenticationError && error.code === 'PASSWORD_POLICY';
  if (error instanceof IdentityError || policy) {
    process.stderr.write(`${error.message}\n`);
    return EXIT.usage;
  }
  if (error instanceof AdministrationError) {
    process.stderr.write(`${error.message}\n`);
    return error.code === 'ADMINISTRATION_FAILED' ? EXIT.failure : EXIT.conflict;
  }
  if (error instanceof InvalidConfigError || error instanceof DatabaseUnavailableError) {
    process.stderr.write(`${error.message}\n`);
    return EXIT.failure;
  }
  // Mensagem e pilha podem conter dados recebidos.
  process.stderr.write('Falha inesperada; nada foi alterado.\n');
  return EXIT.failure;
}

try {
  await main();
} catch (error) {
  process.exitCode = report(error);
}
