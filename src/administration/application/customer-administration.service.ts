import type { PasswordHasher } from '../../authentication/application/ports.js';
import type { PageRequest } from '../../identity/application/facilitator-workspaces.reader.js';
import { IdentityError } from '../../identity/domain/errors.js';
import { parseId, type WorkspaceAccess } from '../../identity/domain/workspace-access.js';
import type { CustomerAdministrationStore, CustomerSummary } from './customer-administration.store.js';
import { AdministrationError } from '../domain/errors.js';
import type { IdentityState } from './operator.store.js';
import type { IssuedCredential, TemporaryCredentialGenerator } from './temporary-credential.js';

export interface CustomerPage {
  readonly items: readonly CustomerSummary[];
  readonly nextOffset: number | null;
}

export interface CustomerState {
  readonly customerId: string;
  readonly status: IdentityState;
}

export interface CustomerAdministrationDependencies {
  readonly store: CustomerAdministrationStore;
  readonly hasher: PasswordHasher;
  readonly generator: TemporaryCredentialGenerator;
  readonly temporaryCredentialHours: number;
}

/** Administração de clientes pelo facilitador, dentro do workspace já confirmado. */
export class CustomerAdministrationService {
  constructor(private readonly deps: CustomerAdministrationDependencies) {}

  async list(access: WorkspaceAccess, { limit, offset }: PageRequest): Promise<CustomerPage> {
    const rows = await this.deps.store.list(access, { limit: limit + 1, offset });
    return { items: rows.slice(0, limit), nextOffset: rows.length > limit ? offset + limit : null };
  }

  async setState(access: WorkspaceAccess, rawCustomerId: unknown, status: IdentityState, correlationId: string): Promise<CustomerState> {
    const customerId = parseId(rawCustomerId);
    if (!(await this.deps.store.setState(access, customerId, status, correlationId))) {
      throw new IdentityError('ACCESS_DENIED');
    }
    return { customerId, status };
  }

  /** Recuperação: a credencial devolvida é a única cópia em claro. Repetir emite outra e revoga esta. */
  async resetPassword(access: WorkspaceAccess, rawCustomerId: unknown, correlationId: string): Promise<IssuedCredential & { customerId: string }> {
    const { store, generator, hasher, temporaryCredentialHours } = this.deps;
    const customerId = parseId(rawCustomerId);
    const temporaryCredential = generator.generate();
    const hash = await hasher.hash(temporaryCredential);
    const issued = await store.issueCredential(access, customerId, hash, temporaryCredentialHours, correlationId);
    if (issued === 'DENIED') {
      throw new IdentityError('ACCESS_DENIED');
    }
    if (issued === 'CONFLICT') {
      throw new AdministrationError('IDENTITY_STATE');
    }
    return { customerId, temporaryCredential, expiresAt: issued };
  }
}
