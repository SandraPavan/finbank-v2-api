import { ReconciliationError } from '../domain/errors.js';
import { parseWorkspaceId, reconcile, type ReconciliationReport } from '../domain/reconciliation.js';
import type { ReconciliationReader } from './reconciliation.reader.js';

/**
 * Reconciliação por workspace: compara saldo materializado e ledger e gera evidência.
 * Não altera dados; a política de reparo ainda não foi definida.
 */
export class ReconciliationService {
  constructor(private readonly reader: ReconciliationReader) {}

  async reconcile(rawWorkspaceId: unknown): Promise<ReconciliationReport> {
    const workspaceId = parseWorkspaceId(rawWorkspaceId);
    const snapshot = await this.reader.readSnapshot(workspaceId);
    if (snapshot === null) {
      throw new ReconciliationError('WORKSPACE_NOT_FOUND');
    }
    return reconcile(workspaceId, snapshot);
  }
}
