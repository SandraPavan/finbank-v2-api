import type { PageRequest } from '../../identity/application/facilitator-workspaces.reader.js';
import type { WorkspaceAccess } from '../../identity/domain/workspace-access.js';
import type { IdentityState } from './operator.store.js';

export interface CustomerSummary {
  readonly customerId: string;
  readonly email: string;
  readonly status: IdentityState;
}

/** DENIED: sem acesso ou cliente de outro workspace. CONFLICT: desativado ou sem senha cadastrada. */
export type CredentialIssue = Date | 'DENIED' | 'CONFLICT';

export interface CustomerAdministrationStore {
  /** Clientes do workspace, por criação e identificador, se o vínculo do ator continua ativo. */
  list(access: WorkspaceAccess, page: PageRequest): Promise<CustomerSummary[]>;
  /** Emite credencial temporária nas mesmas condições. */
  issueCredential(access: WorkspaceAccess, customerId: string, hash: string, hours: number, correlationId: string): Promise<CredentialIssue>;
  /**
   * Muda o estado e registra auditoria numa transação, reconferindo o acesso do ator.
   * Devolve false se o acesso acabou ou o cliente não é do workspace.
   */
  setState(access: WorkspaceAccess, customerId: string, state: IdentityState, correlationId: string): Promise<boolean>;
}
