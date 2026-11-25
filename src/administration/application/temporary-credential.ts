export interface TemporaryCredentialGenerator {
  generate(): string;
}

/** Entregue uma única vez; só o hash é persistido. */
export interface IssuedCredential {
  readonly temporaryCredential: string;
  readonly expiresAt: Date;
}
