import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import { IdentityError } from '../../identity/domain/errors.js';
import { databaseErrorCode } from '../../persistence/database-errors.js';
import { lockWorkspaceUse } from '../../persistence/workspace-locks.js';
import type { NewOnboardingRequest, OnboardingInsert, OnboardingStore, OnboardingWorkspace } from '../application/onboarding.service.js';

const UNIQUE_VIOLATION = '23505';

type Reader = Pick<PrismaClient, '$queryRaw'>;

/** CPF e e-mail já em uso no workspace (solicitações não rejeitadas e, para o e-mail, clientes). */
async function takenFields(db: Reader, request: NewOnboardingRequest): Promise<('cpf' | 'email')[]> {
  const [taken] = await db.$queryRaw<{ cpf: boolean; email: boolean }[]>`
    SELECT
      EXISTS (SELECT 1 FROM "onboarding_request" WHERE "workspace_id" = ${request.workspaceId}::uuid
                AND "cpf" = ${request.cpf} AND "status" <> 'REJECTED') AS "cpf",
      EXISTS (SELECT 1 FROM "onboarding_request" WHERE "workspace_id" = ${request.workspaceId}::uuid
                AND "email" = ${request.email} AND "status" <> 'REJECTED')
      OR EXISTS (SELECT 1 FROM "user_identity" WHERE "workspace_id" = ${request.workspaceId}::uuid
                AND "profile" = 'CUSTOMER' AND "email" = ${request.email}) AS "email"`;
  return (['cpf', 'email'] as const).filter((field) => taken?.[field] === true);
}

export class PrismaOnboardingStore implements OnboardingStore {
  constructor(private readonly client: PrismaClient) {}

  findWorkspace(alias: string): Promise<OnboardingWorkspace | null> {
    return this.guard(async () => {
      const rows = await this.client.$queryRaw<{ id: string; status: string }[]>`
        SELECT "id"::text AS "id", "status"::text AS "status" FROM "workspace" WHERE "alias" = ${alias}`;
      const row = rows[0];
      if (row === undefined) {
        return null;
      }
      if (row.status !== 'ACTIVE' && row.status !== 'ARCHIVED') {
        throw new IdentityError('ACCESS_CHECK_FAILED');
      }
      return { id: row.id, status: row.status };
    });
  }

  insert(request: NewOnboardingRequest): Promise<OnboardingInsert> {
    return this.guard(async () => {
      try {
        return await this.client.$transaction(
          async (tx): Promise<OnboardingInsert> => {
            await lockWorkspaceUse(tx, request.workspaceId);
            const [workspace] = await tx.$queryRaw<{ status: string }[]>`
              SELECT "status"::text AS "status" FROM "workspace" WHERE "id" = ${request.workspaceId}::uuid`;
            if (workspace?.status !== 'ACTIVE') {
              return { kind: 'ARCHIVED' };
            }
            // Conferência prévia: informa todos os campos repetidos; os índices únicos decidem sob concorrência.
            const fields = await takenFields(tx, request);
            if (fields.length > 0) {
              return { kind: 'DUPLICATE', fields };
            }
            const [row] = await tx.$queryRaw<{ id: string }[]>`
              INSERT INTO "onboarding_request"
                ("workspace_id", "status", "name", "cpf", "birth_date", "email", "phone", "password_hash", "business_date", "clock_revision")
              VALUES (${request.workspaceId}::uuid, 'PENDING', ${request.name}, ${request.cpf}, ${request.birthDate}::date, ${request.email},
                      ${request.phone}, ${request.passwordHash}, ${request.businessDate}::date, ${request.clockRevision}::int)
              RETURNING "id"::text AS "id"`;
            return { kind: 'CREATED', requestId: row?.id ?? '' };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 5_000, timeout: 10_000 },
        );
      } catch (error) {
        // Perdeu a disputa para outra gravação já confirmada: a conferência agora a enxerga.
        if (databaseErrorCode(error) === UNIQUE_VIOLATION) {
          const fields = await takenFields(this.client, request);
          if (fields.length > 0) {
            return { kind: 'DUPLICATE', fields };
          }
        }
        throw error;
      }
    });
  }

  private async guard<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      throw error instanceof IdentityError ? error : new IdentityError('ACCESS_CHECK_FAILED', databaseErrorCode(error));
    }
  }
}
