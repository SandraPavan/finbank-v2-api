export type IdentityState = 'ACTIVE' | 'DISABLED';
export type MembershipState = 'ACTIVE' | 'REVOKED';

export interface BootstrapOutcome {
  readonly workspaceCreated: boolean;
  readonly facilitatorCreated: boolean;
  readonly membershipCreated: boolean;
}

/** Escritas do operador. Cada uma é uma transação com a própria auditoria; devolve se houve mudança. */
export interface OperatorStore {
  facilitatorExists(email: string): Promise<boolean>;
  bootstrap(input: { alias: string; email: string; hash: string | null; correlationId: string }): Promise<BootstrapOutcome>;
  createWorkspace(alias: string, correlationId: string): Promise<void>;
  createFacilitator(email: string, hash: string, correlationId: string): Promise<void>;
  createCustomer(alias: string, email: string, hash: string, correlationId: string): Promise<void>;
  setFacilitatorState(email: string, state: IdentityState, correlationId: string): Promise<boolean>;
  setMembership(alias: string, email: string, state: MembershipState, correlationId: string): Promise<boolean>;
}
