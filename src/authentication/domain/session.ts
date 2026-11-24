import type { WorkspaceRole } from '../../identity/domain/workspace-access.js';

/** Prazos em minutos, medidos pelo relógio do banco. */
export interface SessionSettings {
  readonly idleMinutes: number;
  readonly absoluteMinutes: number;
}

/** Sessão ativa. O workspace do cliente vem da identidade (imutável), nunca do alias. */
export interface ActiveSession {
  readonly sessionId: string;
  readonly identityId: string;
  readonly profile: WorkspaceRole;
  /** Workspace do cliente; null para facilitador, que informa o workspace em cada operação. */
  readonly workspaceId: string | null;
  readonly idleExpiresAt: Date;
  readonly absoluteExpiresAt: Date;
}

/** Segredo entregue uma única vez; somente o hash é persistido. */
export interface OpenedSession {
  readonly secret: string;
  readonly session: ActiveSession;
}
