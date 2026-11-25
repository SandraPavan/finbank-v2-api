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
  /** Credencial temporária em uso no lugar da senha invalidada; null para a senha permanente. */
  readonly temporaryId: string | null;
}

export type SessionLookup = ActiveSession | 'INVALID' | 'EXPIRED';

export interface AuthenticationStore {
  findCustomerCredential(alias: string, email: string): Promise<StoredCredential | null>;
  findFacilitatorCredential(email: string): Promise<StoredCredential | null>;
  /** Senha permanente ainda válida. */
  findCredential(identityId: string): Promise<StoredCredential | null>;
  /** Hash da credencial temporária usada por último. */
  findConsumedTemporaryHash(identityId: string): Promise<string | null>;
  /**
   * Abre sessão se a credencial ainda é a verificada e a identidade está ativa; senão null.
   * A temporária é consumida na mesma transação e abre sessão restrita.
   */
  openSession(verified: StoredCredential, tokenHash: string, settings: SessionSettings, correlationId: string): Promise<ActiveSession | null>;
  /** Valida e renova a inatividade, sem ultrapassar o prazo absoluto. */
  touchSession(tokenHash: string, settings: SessionSettings): Promise<SessionLookup>;
  revokeSession(tokenHash: string): Promise<void>;
  /** Encerra todas as sessões da identidade se a sessão informada ainda está ativa. */
  revokeAllSessions(identityId: string, tokenHash: string): Promise<boolean>;
  /** Troca a senha, encerra as sessões e abre outra, numa transação. */
  replacePassword(input: ReplacePasswordInput): Promise<ActiveSession | 'CREDENTIAL_CHANGED' | 'SESSION_ENDED'>;
  /** Grava a senha nova, encerra as sessões e abre uma normal, se a sessão restrita ainda está ativa. */
  completeRecovery(input: CompleteRecoveryInput): Promise<ActiveSession | 'SESSION_ENDED'>;
}

export interface CompleteRecoveryInput {
  readonly identityId: string;
  readonly newHash: string;
  readonly currentTokenHash: string;
  readonly newTokenHash: string;
  readonly settings: SessionSettings;
  readonly correlationId: string;
}

export interface ReplacePasswordInput {
  readonly verified: StoredCredential;
  readonly correlationId: string;
  readonly newHash: string;
  readonly currentTokenHash: string;
  readonly newTokenHash: string;
  readonly settings: SessionSettings;
}
