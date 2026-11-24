import { normalizeEmail } from '../../identity/domain/email.js';
import { IdentityError } from '../../identity/domain/errors.js';
import { parseWorkspaceAlias } from '../../identity/domain/workspace-alias.js';
import { AuthenticationError } from '../domain/errors.js';
import { isAcceptablePassword, parseNewPassword } from '../domain/password-policy.js';
import type { ActiveSession, OpenedSession, SessionSettings } from '../domain/session.js';
import type { AuthenticationStore, PasswordHasher, SessionSecrets, StoredCredential } from './ports.js';

export interface AuthenticationDependencies {
  readonly store: AuthenticationStore;
  readonly hasher: PasswordHasher;
  readonly secrets: SessionSecrets;
  readonly settings: SessionSettings;
  /** Hash de uma senha descartada: iguala o custo quando não há credencial. */
  readonly decoyHash: string;
}

/** Autenticação por senha e ciclo de vida das sessões. Não autoriza operações nem limita tentativas. */
export class AuthenticationService {
  constructor(private readonly deps: AuthenticationDependencies) {}

  async loginCustomer(input: { alias: unknown; email: unknown; password: unknown }): Promise<OpenedSession> {
    const [alias, email] = wellFormed(() => [parseWorkspaceAlias(input.alias), normalizeEmail(input.email)] as const);
    return this.login(input.password, () => this.deps.store.findCustomerCredential(alias, email));
  }

  async loginFacilitator(input: { email: unknown; password: unknown }): Promise<OpenedSession> {
    const email = wellFormed(() => normalizeEmail(input.email));
    return this.login(input.password, () => this.deps.store.findFacilitatorCredential(email));
  }

  /** Valida a sessão e renova a inatividade. */
  async validate(secret: unknown): Promise<ActiveSession> {
    const tokenHash = this.digest(secret);
    const found = await this.deps.store.touchSession(tokenHash, this.deps.settings);
    if (found === 'EXPIRED') {
      throw new AuthenticationError('SESSION_EXPIRED');
    }
    if (found === 'INVALID') {
      throw new AuthenticationError('SESSION_INVALID');
    }
    return found;
  }

  /** Encerra somente a sessão atual. Repetir não tem efeito. */
  async logout(secret: unknown): Promise<void> {
    await this.deps.store.revokeSession(this.digest(secret));
  }

  async logoutAll(secret: unknown): Promise<void> {
    const session = await this.validate(secret);
    if (!(await this.deps.store.revokeAllSessions(session.identityId, this.digest(secret)))) {
      throw new AuthenticationError('SESSION_INVALID');
    }
  }

  async changePassword(secret: unknown, current: unknown, next: unknown): Promise<OpenedSession> {
    const { store, hasher, secrets, settings } = this.deps;
    const session = await this.validate(secret);
    const newPassword = parseNewPassword(next);
    const credential = await store.findCredential(session.identityId);
    if (credential === null || !isAcceptablePassword(current) || !(await hasher.verify(current, credential.hash))) {
      throw new AuthenticationError('INVALID_CREDENTIALS');
    }
    const newSecret = secrets.generate();
    const result = await store.replacePassword({
      verified: credential,
      newHash: await hasher.hash(newPassword),
      currentTokenHash: this.digest(secret),
      newTokenHash: this.digest(newSecret),
      settings,
    });
    if (result === 'CREDENTIAL_CHANGED') {
      throw new AuthenticationError('INVALID_CREDENTIALS');
    }
    if (result === 'SESSION_ENDED') {
      throw new AuthenticationError('SESSION_INVALID');
    }
    return { secret: newSecret, session: result };
  }

  private async login(password: unknown, find: () => Promise<StoredCredential | null>): Promise<OpenedSession> {
    const { store, hasher, secrets, settings, decoyHash } = this.deps;
    if (!isAcceptablePassword(password)) {
      throw new AuthenticationError('INVALID_CREDENTIALS');
    }
    const credential = await find();
    const matches = await hasher.verify(password, credential?.hash ?? decoyHash);
    if (credential === null || !matches) {
      throw new AuthenticationError('INVALID_CREDENTIALS');
    }
    const secret = secrets.generate();
    const session = await store.openSession(credential, this.digest(secret), settings);
    if (session === null) {
      throw new AuthenticationError('INVALID_CREDENTIALS');
    }
    return { secret, session };
  }

  private digest(secret: unknown): string {
    const tokenHash = this.deps.secrets.digest(secret);
    if (tokenHash === null) {
      throw new AuthenticationError('SESSION_INVALID');
    }
    return tokenHash;
  }
}

/** Alias ou e-mail malformado é recusado como qualquer credencial inválida. */
export function wellFormed<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    throw error instanceof IdentityError ? new AuthenticationError('INVALID_CREDENTIALS') : error;
  }
}
