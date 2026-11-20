import type { WorkspaceSnapshot } from '../domain/reconciliation.js';

/** Porta de leitura da reconciliação: um snapshot consistente do workspace, somente leitura. */
export interface ReconciliationReader {
  /** Devolve null quando o workspace não existe. */
  readSnapshot(workspaceId: string): Promise<WorkspaceSnapshot | null>;
}
