import type { ActiveSession, SessionSettings } from '../domain/session.js';

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(password: string, hash: string): Promise<boolean>;
}

export interface SessionSecrets {
  generate(): string;
  /** Hash persistido do segredo; null se o valor não tem o formato de um segredo. */
  digest(raw: unknown): string | null;
}

export interface StoredCredential {
  readonly identityId: string;
  readonly hash: string;
}

export type SessionLookup = ActiveSession | 'INVALID' | 'EXPIRED';

export interface AuthenticationStore {
  findCustomerCredential(alias: string, email: string): Promise<StoredCredential | null>;
  findFacilitatorCredential(email: string): Promise<StoredCredential | null>;
  findCredential(identityId: string): Promise<StoredCredential | null>;
  /** Abre sessão se a credencial ainda é a verificada e a identidade está ativa; senão null. */
  openSession(verified: StoredCredential, tokenHash: string, settings: SessionSettings): Promise<ActiveSession | null>;
  /** Valida e renova a inatividade, sem ultrapassar o prazo absoluto. */
  touchSession(tokenHash: string, settings: SessionSettings): Promise<SessionLookup>;
  revokeSession(tokenHash: string): Promise<void>;
  /** Encerra todas as sessões da identidade se a sessão informada ainda está ativa. */
  revokeAllSessions(identityId: string, tokenHash: string): Promise<boolean>;
  /** Troca a senha, encerra as sessões e abre outra, numa transação. */
  replacePassword(input: ReplacePasswordInput): Promise<ActiveSession | 'CREDENTIAL_CHANGED' | 'SESSION_ENDED'>;
}

export interface ReplacePasswordInput {
  readonly verified: StoredCredential;
  readonly newHash: string;
  readonly currentTokenHash: string;
  readonly newTokenHash: string;
  readonly settings: SessionSettings;
}
