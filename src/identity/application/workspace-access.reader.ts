/** Porta de leitura do acesso de uma identidade a um workspace. */
export interface WorkspaceAccessReader {
  /**
   * Perfil da identidade ativa que acessa o workspace: cliente, só o próprio; facilitador, só com
   * vínculo ativo. Null em qualquer outro caso.
   */
  findActiveRole(identityId: string, workspaceId: string): Promise<string | null>;
}
