import type { CookieTransport } from '../../config/app-config.js';
import { type HttpRequest, header } from '../../http/http-types.js';
import { ProblemError } from '../../http/problem.js';
import type { AuthenticationService } from '../application/authentication.service.js';
import { AuthenticationError } from '../domain/errors.js';
import type { ActiveSession } from '../domain/session.js';
import { type ContextCookies, ContextCookieJar } from './cookies.js';
import { csrfMatches } from './csrf.js';

const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:[0-9]{1,5})?$/i;

export interface AuthenticatedContext {
  readonly secret: string;
  readonly session: ActiveSession;
}

/** Regras de transporte, contexto e CSRF comuns às rotas de autenticação. */
export class AuthContext {
  readonly cookies: ContextCookieJar;

  constructor(
    private readonly auth: AuthenticationService,
    private readonly transport: CookieTransport,
  ) {
    this.cookies = new ContextCookieJar(transport);
  }

  /** Primeira checagem de toda rota: em HTTP local, só endereços de loopback. */
  read(request: HttpRequest): ContextCookies {
    if (this.transport === 'local-http' && !LOOPBACK_HOST.test(header(request, 'host') ?? '')) {
      throw new ProblemError('ACCESS_DENIED');
    }
    return this.cookies.read(request);
  }

  /** Sessão ativa do contexto, ou null se não há sessão ou ela terminou. */
  async current(cookies: ContextCookies): Promise<AuthenticatedContext | null> {
    if (cookies.session === undefined) {
      return null;
    }
    try {
      return { secret: cookies.session, session: await this.auth.validate(cookies.session) };
    } catch (error) {
      if (error instanceof AuthenticationError && (error.code === 'SESSION_INVALID' || error.code === 'SESSION_EXPIRED')) {
        return null;
      }
      throw error;
    }
  }

  /** Sessão normal. A restrita é recusada por padrão. */
  async required(cookies: ContextCookies): Promise<AuthenticatedContext> {
    const context = await this.requiredAnyScope(cookies);
    if (context.session.scope !== 'NORMAL') {
      throw new ProblemError('PASSWORD_CHANGE_REQUIRED');
    }
    return context;
  }

  /** Somente para as operações permitidas na recuperação. */
  async requiredAnyScope(cookies: ContextCookies): Promise<AuthenticatedContext> {
    if (cookies.session === undefined) {
      throw new ProblemError('AUTH_SESSION_REQUIRED');
    }
    return { secret: cookies.session, session: await this.auth.validate(cookies.session) };
  }

  /** Exige o token do contexto informado. Sem contexto não há token válido. */
  requireCsrf(request: HttpRequest, contextSecret: string | undefined): void {
    if (
      header(request, 'sec-fetch-site') === 'cross-site' ||
      contextSecret === undefined ||
      !csrfMatches(contextSecret, header(request, 'x-csrf-token'))
    ) {
      throw new ProblemError('CSRF_VALIDATION_FAILED');
    }
  }

  rejectCrossSite(request: HttpRequest): void {
    if (header(request, 'sec-fetch-site') === 'cross-site') {
      throw new ProblemError('CSRF_VALIDATION_FAILED');
    }
  }
}
