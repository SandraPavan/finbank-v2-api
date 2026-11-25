import type { PageRequest } from '../../identity/application/facilitator-workspaces.reader.js';
import { IdentityError } from '../../identity/domain/errors.js';
import { parseId, type WorkspaceAccess } from '../../identity/domain/workspace-access.js';
import type { CustomerAdministrationStore, CustomerSummary } from './customer-administration.store.js';
import type { IdentityState } from './operator.store.js';

export interface CustomerPage {
  readonly items: readonly CustomerSummary[];
  readonly nextOffset: number | null;
}

export interface CustomerState {
  readonly customerId: string;
  readonly status: IdentityState;
}

/** Administração de clientes pelo facilitador, dentro do workspace já confirmado. */
export class CustomerAdministrationService {
  constructor(private readonly store: CustomerAdministrationStore) {}

  async list(access: WorkspaceAccess, { limit, offset }: PageRequest): Promise<CustomerPage> {
    const rows = await this.store.list(access, { limit: limit + 1, offset });
    return { items: rows.slice(0, limit), nextOffset: rows.length > limit ? offset + limit : null };
  }

  async setState(access: WorkspaceAccess, rawCustomerId: unknown, status: IdentityState, correlationId: string): Promise<CustomerState> {
    const customerId = parseId(rawCustomerId);
    if (!(await this.store.setState(access, customerId, status, correlationId))) {
      throw new IdentityError('ACCESS_DENIED');
    }
    return { customerId, status };
  }
}
