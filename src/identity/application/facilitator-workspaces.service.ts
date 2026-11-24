import { IdentityError } from '../domain/errors.js';
import { parseId, type WorkspaceAccess } from '../domain/workspace-access.js';
import type { FacilitatorWorkspacesReader, PageRequest, WorkspaceSummary } from './facilitator-workspaces.reader.js';

export interface WorkspacePage {
  readonly items: readonly WorkspaceSummary[];
  /** Início da próxima página, ou null na última. */
  readonly nextOffset: number | null;
}

/** Consultas do facilitador. Cada consulta reconfere identidade e vínculo na própria instrução. */
export class FacilitatorWorkspacesService {
  constructor(private readonly reader: FacilitatorWorkspacesReader) {}

  async list(rawIdentityId: unknown, page: PageRequest): Promise<WorkspacePage> {
    const { limit, offset } = page;
    const rows = await this.reader.list(parseId(rawIdentityId), { limit: limit + 1, offset });
    return { items: rows.slice(0, limit), nextOffset: rows.length > limit ? offset + limit : null };
  }

  /** O acesso pode ter sido revogado depois de confirmado: sem linha, é negação. */
  async find(access: WorkspaceAccess): Promise<WorkspaceSummary> {
    const found = await this.reader.find(access.identityId, access.workspaceId);
    if (found === null) {
      throw new IdentityError('ACCESS_DENIED');
    }
    return found;
  }
}
