/** Porta de leitura do vínculo entre identidade e workspace. */
export interface WorkspaceAccessReader {
  /** Papel do vínculo ativo de uma identidade ativa; null em qualquer outro caso. */
  findActiveRole(identityId: string, workspaceId: string): Promise<string | null>;
}
