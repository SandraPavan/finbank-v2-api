import type { PasswordHasher } from '../../authentication/application/ports.js';
import { parseNewPassword } from '../../authentication/domain/password-policy.js';
import { normalizeEmail } from '../../identity/domain/email.js';
import { parseWorkspaceAlias } from '../../identity/domain/workspace-alias.js';
import type { BootstrapOutcome, IdentityState, MembershipState, OperatorStore } from './operator.store.js';

/** Obtém a senha só quando ela é necessária. */
export type PasswordSource = () => Promise<string>;

export interface OperatorDependencies {
  readonly store: OperatorStore;
  readonly hasher: PasswordHasher;
  readonly correlationId: string;
}

/** Operações do operador de infraestrutura. Sem rota: usadas somente pela linha de comando. */
export class OperatorService {
  constructor(private readonly deps: OperatorDependencies) {}

  /** Garante workspace, facilitador e vínculo. Não pede nem altera senha de facilitador existente. */
  async bootstrap(rawAlias: unknown, rawEmail: unknown, password: PasswordSource): Promise<BootstrapOutcome> {
    const alias = parseWorkspaceAlias(rawAlias);
    const email = normalizeEmail(rawEmail);
    const hash = (await this.deps.store.facilitatorExists(email)) ? null : await this.hash(password);
    return this.deps.store.bootstrap({ alias, email, hash, correlationId: this.deps.correlationId });
  }

  async createWorkspace(rawAlias: unknown): Promise<void> {
    await this.deps.store.createWorkspace(parseWorkspaceAlias(rawAlias), this.deps.correlationId);
  }

  async createFacilitator(rawEmail: unknown, password: PasswordSource): Promise<void> {
    const email = normalizeEmail(rawEmail);
    await this.deps.store.createFacilitator(email, await this.hash(password), this.deps.correlationId);
  }

  async createCustomer(rawAlias: unknown, rawEmail: unknown, password: PasswordSource): Promise<void> {
    const alias = parseWorkspaceAlias(rawAlias);
    const email = normalizeEmail(rawEmail);
    await this.deps.store.createCustomer(alias, email, await this.hash(password), this.deps.correlationId);
  }

  async setFacilitatorState(rawEmail: unknown, state: IdentityState): Promise<boolean> {
    return this.deps.store.setFacilitatorState(normalizeEmail(rawEmail), state, this.deps.correlationId);
  }

  async setMembership(rawAlias: unknown, rawEmail: unknown, state: MembershipState): Promise<boolean> {
    const alias = parseWorkspaceAlias(rawAlias);
    return this.deps.store.setMembership(alias, normalizeEmail(rawEmail), state, this.deps.correlationId);
  }

  private async hash(password: PasswordSource): Promise<string> {
    return this.deps.hasher.hash(parseNewPassword(await password()));
  }
}
