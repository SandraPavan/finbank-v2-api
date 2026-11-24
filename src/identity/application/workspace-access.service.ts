import { IdentityError } from '../domain/errors.js';
import { parseId, parseRole, type WorkspaceAccess } from '../domain/workspace-access.js';
import type { WorkspaceAccessReader } from './workspace-access.reader.js';

/**
 * Responde se uma identidade acessa um workspace e com qual papel. Nega por padrão.
 * Não autentica: a identidade informada precisa vir de uma autenticação validada.
 * Sem cache: uma revogação vale na consulta seguinte.
 */
export class WorkspaceAccessService {
  constructor(private readonly reader: WorkspaceAccessReader) {}

  async resolve(rawIdentityId: unknown, rawWorkspaceId: unknown): Promise<WorkspaceAccess> {
    const identityId = parseId(rawIdentityId);
    const workspaceId = parseId(rawWorkspaceId);
    const role = await this.reader.findActiveRole(identityId, workspaceId);
    if (role === null) {
      throw new IdentityError('ACCESS_DENIED');
    }
    return Object.freeze({ identityId, workspaceId, role: parseRole(role) });
  }
}
