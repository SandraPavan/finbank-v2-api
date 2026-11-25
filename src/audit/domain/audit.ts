import type { WorkspaceRole } from '../../identity/domain/workspace-access.js';

export type AuditActor =
  | { readonly type: 'OPERATOR' }
  | { readonly type: 'IDENTITY'; readonly identityId: string; readonly profile: WorkspaceRole };

export type AuditOperation =
  | 'BOOTSTRAP'
  | 'WORKSPACE_CREATE'
  | 'FACILITATOR_CREATE'
  | 'FACILITATOR_DISABLE'
  | 'FACILITATOR_ENABLE'
  | 'MEMBERSHIP_GRANT'
  | 'MEMBERSHIP_REVOKE'
  | 'CUSTOMER_CREATE'
  | 'CUSTOMER_DISABLE'
  | 'CUSTOMER_ENABLE'
  | 'PASSWORD_RESET_ISSUE'
  | 'TEMPORARY_CREDENTIAL_CONSUME'
  | 'PASSWORD_RECOVERY_COMPLETE'
  | 'PASSWORD_CHANGE';

/** Em vínculos, o recurso é a identidade do facilitador; o workspace completa o par. */
export type AuditResource = 'WORKSPACE' | 'IDENTITY' | 'MEMBERSHIP';

/** Registro de uma operação. Só códigos e identificadores: nunca senha, e-mail ou segredo. */
export interface AuditEntry {
  readonly actor: AuditActor;
  readonly workspaceId: string | null;
  readonly operation: AuditOperation;
  readonly resource: AuditResource;
  readonly resourceId: string;
  readonly changed: boolean;
  readonly correlationId: string;
}
