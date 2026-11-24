import { isAcceptablePassword } from '../domain/password-policy.js';
import { AuthenticationError } from '../domain/errors.js';
import type { ActiveSession, OpenedSession } from '../domain/session.js';
import type { AttemptLimiter } from './attempt-limiter.js';
import { type AuthenticationService, wellFormed } from './authentication.service.js';
import { normalizeEmail } from '../../identity/domain/email.js';
import { parseWorkspaceAlias } from '../../identity/domain/workspace-alias.js';

/**
 * Autenticação com limite de tentativas: a única forma de expor login e troca de senha por rede.
 * Entrada malformada é recusada como credencial inválida, sem contar tentativa.
 */
export class LimitedAuthenticationService {
  constructor(
    private readonly auth: AuthenticationService,
    private readonly limiter: AttemptLimiter,
  ) {}

  async loginCustomer(input: { alias: string; email: string; password: string }): Promise<OpenedSession> {
    const [alias, email] = wellFormed(() => [parseWorkspaceAlias(input.alias), normalizeEmail(input.email)] as const);
    requirePassword(input.password);
    return this.limiter.run(subject('customer', alias, email), () => this.auth.loginCustomer(input));
  }

  async loginFacilitator(input: { email: string; password: string }): Promise<OpenedSession> {
    const email = wellFormed(() => normalizeEmail(input.email));
    requirePassword(input.password);
    return this.limiter.run(subject('facilitator', email), () => this.auth.loginFacilitator(input));
  }

  /** A sessão já validada identifica o assunto; a própria troca a valida de novo. */
  changePassword(session: ActiveSession, secret: string, current: string, next: string): Promise<OpenedSession> {
    return this.limiter.run(subject('password', session.identityId), () => this.auth.changePassword(secret, current, next));
  }
}

function requirePassword(password: string): void {
  if (!isAcceptablePassword(password)) {
    throw new AuthenticationError('INVALID_CREDENTIALS');
  }
}

/** Codificação sem ambiguidade; o adaptador guarda só o SHA-256. */
function subject(...parts: string[]): string {
  return JSON.stringify(parts);
}
