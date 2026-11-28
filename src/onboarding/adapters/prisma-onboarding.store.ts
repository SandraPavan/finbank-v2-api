import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import { insertAudit } from '../../audit/adapters/insert-audit.js';
import type { AuditActor } from '../../audit/domain/audit.js';
import { IdentityError } from '../../identity/domain/errors.js';
import type { WorkspaceAccess } from '../../identity/domain/workspace-access.js';
import { openCustomerAccount } from '../../payment-execution/adapters/prisma-payment-execution.store.js';
import { databaseErrorCode } from '../../persistence/database-errors.js';
import { lockFacilitatorUse } from '../../persistence/facilitator-locks.js';
import { lockWorkspaceUse } from '../../persistence/workspace-locks.js';
import type {
  DecisionResult,
  OnboardingAdministrationStore,
  OnboardingRequestSummary,
  PolicyPublish,
  PolicyState,
} from '../application/onboarding-administration.service.js';
import type { NewOnboardingRequest, OnboardingInsert, OnboardingStore, OnboardingWorkspace } from '../application/onboarding.service.js';
import { type ApprovalMode, DEFAULT_APPROVAL_MODE, isApprovalMode, isOnboardingStatus, type OnboardingDecision, type OnboardingStatus } from '../domain/approval-policy.js';
import { STATUS_CREDENTIAL_HOURS } from '../domain/status-credential.js';

const UNIQUE_VIOLATION = '23505';
const TRANSACTION = { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 5_000, timeout: 10_000 };

type Tx = Prisma.TransactionClient;
type Reader = Pick<PrismaClient, '$queryRaw'>;

function required(id: string | undefined): string {
  if (id === undefined) {
    throw new IdentityError('ACCESS_CHECK_FAILED');
  }
  return id;
}

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

/** Política vigente do workspace; sem revisão gravada, AUTOMATIC (revisão 0). */
async function currentPolicy(db: Reader, workspaceId: string): Promise<PolicyState> {
  const [row] = await db.$queryRaw<{ mode: string; revision: number }[]>`
    SELECT "mode"::text AS "mode", "revision" FROM "onboarding_policy_revision"
     WHERE "workspace_id" = ${workspaceId}::uuid ORDER BY "revision" DESC LIMIT 1`;
  if (row === undefined) {
    return { mode: DEFAULT_APPROVAL_MODE, revision: 0 };
  }
  if (!isApprovalMode(row.mode)) {
    throw new IdentityError('ACCESS_CHECK_FAILED');
  }
  return { mode: row.mode, revision: row.revision };
}

/** Estado do workspace sob a trava de uso: só ACTIVE aceita escrita. */
async function activeWorkspace(tx: Tx, workspaceId: string): Promise<boolean> {
  await lockWorkspaceUse(tx, workspaceId);
  const [workspace] = await tx.$queryRaw<{ status: string }[]>`
    SELECT "status"::text AS "status" FROM "workspace" WHERE "id" = ${workspaceId}::uuid`;
  return workspace?.status === 'ACTIVE';
}

/** Vínculo ativo do facilitador, reconferido na transação. */
async function facilitatorLinked(tx: Tx, access: WorkspaceAccess): Promise<boolean> {
  await lockFacilitatorUse(tx, access.identityId);
  const allowed = await tx.$queryRaw<unknown[]>`
    SELECT 1 AS "ok" FROM "user_identity" f
      JOIN "workspace_membership" m ON m."identity_id" = f."id" AND m."status" = 'ACTIVE'
     WHERE f."id" = ${access.identityId}::uuid AND f."status" = 'ACTIVE' AND f."profile" = 'FACILITATOR'
       AND m."workspace_id" = ${access.workspaceId}::uuid`;
  return allowed.length === 1;
}

/** Aprovação: cliente ativo, senha da solicitação, conta comum de saldo zero e vínculo. Devolve o cliente. */
async function createCustomer(tx: Tx, workspaceId: string, email: string, passwordHash: string): Promise<string> {
  const [identity] = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO "user_identity" ("status", "profile", "email", "workspace_id")
    VALUES ('ACTIVE', 'CUSTOMER', ${email}, ${workspaceId}::uuid)
    RETURNING "id"::text AS "id"`;
  const identityId = required(identity?.id);
  await tx.$executeRaw`
    INSERT INTO "password_credential" ("identity_id", "hash") VALUES (${identityId}::uuid, ${passwordHash})`;
  const accountId = await openCustomerAccount(tx, workspaceId);
  await tx.$executeRaw`
    INSERT INTO "customer_account" ("identity_id", "workspace_id", "account_id")
    VALUES (${identityId}::uuid, ${workspaceId}::uuid, ${accountId}::uuid)`;
  return identityId;
}

async function auditDecision(tx: Tx, actor: AuditActor, workspaceId: string, requestId: string, decision: OnboardingDecision, correlationId: string): Promise<void> {
  await insertAudit(tx, {
    actor,
    workspaceId,
    operation: decision === 'APPROVED' ? 'ONBOARDING_APPROVE' : 'ONBOARDING_REJECT',
    resource: 'ONBOARDING_REQUEST',
    resourceId: requestId,
    changed: true,
    correlationId,
  });
}

export class PrismaOnboardingStore implements OnboardingStore, OnboardingAdministrationStore {
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

  insert(request: NewOnboardingRequest, correlationId: string): Promise<OnboardingInsert> {
    return this.guard(async () => {
      try {
        return await this.client.$transaction(async (tx): Promise<OnboardingInsert> => {
          if (!(await activeWorkspace(tx, request.workspaceId))) {
            return { kind: 'ARCHIVED' };
          }
          // Conferência prévia: informa todos os campos repetidos; os índices únicos decidem sob concorrência.
          const fields = await takenFields(tx, request);
          if (fields.length > 0) {
            return { kind: 'DUPLICATE', fields };
          }
          const policy = await currentPolicy(tx, request.workspaceId);
          if (policy.mode === 'MANUAL') {
            const [row] = await tx.$queryRaw<{ id: string; expiresAt: Date }[]>`
              INSERT INTO "onboarding_request"
                ("workspace_id", "status", "name", "cpf", "birth_date", "email", "phone", "password_hash", "business_date", "clock_revision",
                 "policy_revision", "status_credential_hash", "status_credential_expires_at")
              VALUES (${request.workspaceId}::uuid, 'PENDING', ${request.name}, ${request.cpf}, ${request.birthDate}::date, ${request.email},
                      ${request.phone}, ${request.passwordHash}, ${request.businessDate}::date, ${request.clockRevision}::int,
                      ${policy.revision}::int, ${request.statusCredentialHash}, clock_timestamp() + make_interval(hours => ${STATUS_CREDENTIAL_HOURS}::int))
              RETURNING "id"::text AS "id", "status_credential_expires_at" AS "expiresAt"`;
            return { kind: 'PENDING', requestId: required(row?.id), statusCredentialExpiresAt: row?.expiresAt ?? new Date(0) };
          }
          // Aprovação simulada automática: cliente, senha, conta e vínculo, tudo ou nada.
          const identityId = await createCustomer(tx, request.workspaceId, request.email, request.passwordHash);
          const [row] = await tx.$queryRaw<{ id: string }[]>`
            INSERT INTO "onboarding_request"
              ("workspace_id", "status", "name", "cpf", "birth_date", "email", "phone", "password_hash", "business_date", "clock_revision",
               "identity_id", "decided_at", "policy_revision")
            VALUES (${request.workspaceId}::uuid, 'APPROVED', ${request.name}, ${request.cpf}, ${request.birthDate}::date, ${request.email},
                    ${request.phone}, ${request.passwordHash}, ${request.businessDate}::date, ${request.clockRevision}::int,
                    ${identityId}::uuid, clock_timestamp(), ${policy.revision}::int)
            RETURNING "id"::text AS "id"`;
          const requestId = required(row?.id);
          await auditDecision(tx, { type: 'SYSTEM' }, request.workspaceId, requestId, 'APPROVED', correlationId);
          return { kind: 'APPROVED', requestId };
        }, TRANSACTION);
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

  findStatus(requestId: string, credentialHash: string): Promise<OnboardingStatus | null> {
    return this.guard(async () => {
      const [row] = await this.client.$queryRaw<{ status: string }[]>`
        SELECT "status"::text AS "status" FROM "onboarding_request"
         WHERE "id" = ${requestId}::uuid AND "status_credential_hash" = ${credentialHash}
           AND "status_credential_expires_at" > clock_timestamp()`;
      if (row === undefined) {
        return null;
      }
      if (!isOnboardingStatus(row.status)) {
        throw new IdentityError('ACCESS_CHECK_FAILED');
      }
      return row.status;
    });
  }

  policy(workspaceId: string): Promise<PolicyState> {
    return this.guard(() => currentPolicy(this.client, workspaceId));
  }

  publishPolicy(access: WorkspaceAccess, revision: number, mode: ApprovalMode, correlationId: string): Promise<PolicyPublish> {
    return this.guard(async () => {
      try {
        return await this.client.$transaction(async (tx): Promise<PolicyPublish> => {
          if (!(await facilitatorLinked(tx, access))) {
            return 'DENIED';
          }
          if (!(await activeWorkspace(tx, access.workspaceId))) {
            return 'ARCHIVED';
          }
          const [row] = await tx.$queryRaw<{ id: string }[]>`
            INSERT INTO "onboarding_policy_revision" ("workspace_id", "revision", "mode", "created_by")
            VALUES (${access.workspaceId}::uuid, ${revision}::int, ${mode}::"onboarding_approval_mode", ${access.identityId}::uuid)
            RETURNING "id"::text AS "id"`;
          await insertAudit(tx, {
            actor: { type: 'IDENTITY', identityId: access.identityId, profile: access.role },
            workspaceId: access.workspaceId,
            operation: 'ONBOARDING_POLICY_CHANGE',
            resource: 'ONBOARDING_POLICY_REVISION',
            resourceId: required(row?.id),
            changed: true,
            correlationId,
          });
          return 'PUBLISHED';
        }, TRANSACTION);
      } catch (error) {
        if (databaseErrorCode(error) === UNIQUE_VIOLATION) {
          return 'CONFLICT';
        }
        throw error;
      }
    });
  }

  list(workspaceId: string, status: OnboardingStatus | null, page: { limit: number; offset: number }): Promise<OnboardingRequestSummary[]> {
    return this.guard(async () => {
      const rows = await this.client.$queryRaw<{
        requestId: string; status: string; name: string; email: string; businessDate: string; createdAt: Date; decidedAt: Date | null;
      }[]>`
        SELECT "id"::text AS "requestId", "status"::text AS "status", "name", "email",
               to_char("business_date", 'YYYY-MM-DD') AS "businessDate", "created_at" AS "createdAt", "decided_at" AS "decidedAt"
          FROM "onboarding_request"
         WHERE "workspace_id" = ${workspaceId}::uuid AND (${status}::text IS NULL OR "status"::text = ${status}::text)
         ORDER BY "created_at", "id"
         LIMIT ${page.limit}::int OFFSET ${page.offset}::int`;
      return rows.map((row) => {
        if (!isOnboardingStatus(row.status)) {
          throw new IdentityError('ACCESS_CHECK_FAILED');
        }
        return {
          requestId: row.requestId,
          status: row.status,
          name: row.name,
          email: row.email,
          businessDate: row.businessDate,
          createdAt: row.createdAt.toISOString(),
          decidedAt: row.decidedAt?.toISOString() ?? null,
        };
      });
    });
  }

  decide(access: WorkspaceAccess, requestId: string, decision: OnboardingDecision, correlationId: string): Promise<DecisionResult> {
    return this.guard(async () => {
      try {
        return await this.client.$transaction(async (tx): Promise<DecisionResult> => {
          if (!(await facilitatorLinked(tx, access))) {
            return { kind: 'DENIED' };
          }
          if (!(await activeWorkspace(tx, access.workspaceId))) {
            return { kind: 'ARCHIVED' };
          }
          // A trava da linha serializa decisões concorrentes sobre a mesma solicitação.
          const [request] = await tx.$queryRaw<{ status: string; email: string; passwordHash: string }[]>`
            SELECT "status"::text AS "status", "email", "password_hash" AS "passwordHash" FROM "onboarding_request"
             WHERE "id" = ${requestId}::uuid AND "workspace_id" = ${access.workspaceId}::uuid
             FOR NO KEY UPDATE`;
          if (request === undefined) {
            return { kind: 'NOT_FOUND' };
          }
          if (request.status !== 'PENDING') {
            return request.status === decision ? { kind: 'UNCHANGED', status: decision } : { kind: 'ALREADY_DECIDED' };
          }
          const actor: AuditActor = { type: 'IDENTITY', identityId: access.identityId, profile: access.role };
          if (decision === 'APPROVED') {
            const [taken] = await tx.$queryRaw<{ taken: boolean }[]>`
              SELECT EXISTS (SELECT 1 FROM "user_identity" WHERE "workspace_id" = ${access.workspaceId}::uuid
                               AND "profile" = 'CUSTOMER' AND "email" = ${request.email}) AS "taken"`;
            if (taken?.taken === true) {
              return { kind: 'DUPLICATE' };
            }
            const identityId = await createCustomer(tx, access.workspaceId, request.email, request.passwordHash);
            await tx.$executeRaw`
              UPDATE "onboarding_request" SET "status" = 'APPROVED', "identity_id" = ${identityId}::uuid, "decided_at" = clock_timestamp()
               WHERE "id" = ${requestId}::uuid`;
          } else {
            await tx.$executeRaw`
              UPDATE "onboarding_request" SET "status" = 'REJECTED', "decided_at" = clock_timestamp() WHERE "id" = ${requestId}::uuid`;
          }
          await auditDecision(tx, actor, access.workspaceId, requestId, decision, correlationId);
          return { kind: 'DECIDED', status: decision };
        }, TRANSACTION);
      } catch (error) {
        // E-mail tomado por um cliente da linha de comando no meio da aprovação.
        if (decision === 'APPROVED' && databaseErrorCode(error) === UNIQUE_VIOLATION) {
          return { kind: 'DUPLICATE' };
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
