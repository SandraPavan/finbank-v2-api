import { SetMetadata } from '@nestjs/common';

/**
 * Quem pode usar a rota. Rota sem política é negada pela guarda.
 * - PUBLIC: sem identidade.
 * - AUTHENTICATION: a própria rota aplica os controles de contexto e CSRF.
 * - perfil: exige sessão e perfil; com `workspace`, também vínculo com o workspace do caminho.
 */
export type AccessPolicy =
  | { readonly kind: 'PUBLIC' }
  | { readonly kind: 'AUTHENTICATION' }
  | { readonly kind: 'PROFILE'; readonly profile: 'CUSTOMER' | 'FACILITATOR'; readonly workspace: boolean };

export const ACCESS_POLICY = Symbol('ACCESS_POLICY');

/** Parâmetro do caminho que designa o workspace. */
export const WORKSPACE_PARAM = 'workspaceId';

const declare = (policy: AccessPolicy) => SetMetadata(ACCESS_POLICY, Object.freeze(policy));

export const PublicAccess = () => declare({ kind: 'PUBLIC' });
export const AuthenticationAccess = () => declare({ kind: 'AUTHENTICATION' });
export const FacilitatorAccess = () => declare({ kind: 'PROFILE', profile: 'FACILITATOR', workspace: false });
export const FacilitatorWorkspaceAccess = () => declare({ kind: 'PROFILE', profile: 'FACILITATOR', workspace: true });
