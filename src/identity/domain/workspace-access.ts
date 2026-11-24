import { IdentityError } from './errors.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const WORKSPACE_ROLES = ['CUSTOMER', 'FACILITATOR'] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

/** Acesso confirmado àquele workspace, e somente a ele. O papel é o perfil da identidade. */
export interface WorkspaceAccess {
  readonly identityId: string;
  readonly workspaceId: string;
  readonly role: WorkspaceRole;
}

export function parseId(raw: unknown): string {
  if (typeof raw !== 'string' || !UUID_PATTERN.test(raw)) {
    throw new IdentityError('INVALID_INPUT');
  }
  return raw;
}

/** Papel fora do conjunto conhecido é falha de verificação, nunca acesso. */
export function parseRole(raw: unknown): WorkspaceRole {
  const role = WORKSPACE_ROLES.find((known) => known === raw);
  if (role === undefined) {
    throw new IdentityError('ACCESS_CHECK_FAILED');
  }
  return role;
}
