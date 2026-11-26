/**
 * Modalidade do workspace, fixa na criação. SHARED: turma, código de inscrição obrigatório.
 * ISOLATED: estudo individual, código opcional. Distinta da classificação da implantação.
 */
export const WORKSPACE_MODALITIES = ['SHARED', 'ISOLATED'] as const;
export type WorkspaceModality = (typeof WORKSPACE_MODALITIES)[number];

export function isWorkspaceModality(value: unknown): value is WorkspaceModality {
  return typeof value === 'string' && (WORKSPACE_MODALITIES as readonly string[]).includes(value);
}
