/** Limite de tentativas. Tempos medidos pelo relógio do banco. */
export interface LoginLimits {
  readonly maxAttempts: number;
  readonly windowMinutes: number;
  /** Primeira restrição; cada falha seguinte dobra, até o máximo. */
  readonly restrictionSeconds: number;
  readonly maxRestrictionSeconds: number;
}
