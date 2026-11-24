import { Body, Controller, Get, HttpCode, Post, Req, Res, UseFilters } from '@nestjs/common';
import { AuthenticationAccess } from '../../http/access-policy.js';
import { parseNoBody, parseTextFields } from '../../http/body.js';
import type { HttpRequest, HttpResponse } from '../../http/http-types.js';
import { ProblemError } from '../../http/problem.js';
import { AuthenticationService } from '../application/authentication.service.js';
import { LimitedAuthenticationService } from '../application/limited-authentication.service.js';
import { RandomSessionSecrets } from '../adapters/random-session-secrets.js';
import { AuthenticationError } from '../domain/errors.js';
import type { ActiveSession, OpenedSession } from '../domain/session.js';
import { AuthContext } from './auth-context.js';
import { AuthenticationProblemFilter } from './authentication-problem.filter.js';
import { csrfToken } from './csrf.js';

interface SessionView {
  readonly identityId: string;
  readonly profile: string;
  readonly workspaceId: string | null;
  readonly idleExpiresAt: string;
  readonly absoluteExpiresAt: string;
}

type OpenedView = SessionView & { readonly csrfToken: string };

function view(session: ActiveSession): SessionView {
  return {
    identityId: session.identityId,
    profile: session.profile,
    workspaceId: session.workspaceId,
    idleExpiresAt: session.idleExpiresAt.toISOString(),
    absoluteExpiresAt: session.absoluteExpiresAt.toISOString(),
  };
}

@Controller('api/v1/auth')
@AuthenticationAccess()
@UseFilters(AuthenticationProblemFilter)
export class AuthenticationController {
  constructor(
    private readonly auth: AuthenticationService,
    private readonly limited: LimitedAuthenticationService,
    private readonly context: AuthContext,
    private readonly secrets: RandomSessionSecrets,
  ) {}

  @Get('csrf')
  async csrf(@Req() request: HttpRequest, @Res({ passthrough: true }) response: HttpResponse): Promise<{ csrfToken: string }> {
    const cookies = this.context.read(request);
    const current = await this.context.current(cookies);
    let secret = current?.secret ?? cookies.preauth;
    if (secret === undefined) {
      secret = this.secrets.generate();
      this.context.cookies.setPreauth(response, secret);
    }
    return { csrfToken: csrfToken(secret) };
  }

  @Post('customer/login')
  @HttpCode(200)
  loginCustomer(
    @Req() request: HttpRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<OpenedView> {
    return this.login(request, response, () => {
      const input = parseTextFields(body, ['alias', 'email', 'password']);
      return this.limited.loginCustomer(input);
    });
  }

  @Post('facilitator/login')
  @HttpCode(200)
  loginFacilitator(
    @Req() request: HttpRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<OpenedView> {
    return this.login(request, response, () => {
      const input = parseTextFields(body, ['email', 'password']);
      return this.limited.loginFacilitator(input);
    });
  }

  @Get('me')
  async me(@Req() request: HttpRequest): Promise<SessionView> {
    const { session } = await this.context.required(this.context.read(request));
    return view(session);
  }

  /** Encerra a sessão do contexto, mesmo já terminada, e remove os cookies. */
  @Post('logout')
  @HttpCode(204)
  async logout(
    @Req() request: HttpRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<void> {
    const cookies = this.context.read(request);
    const secret = cookies.session ?? cookies.preauth;
    if (secret === undefined) {
      this.context.rejectCrossSite(request);
    } else {
      this.context.requireCsrf(request, secret);
    }
    parseNoBody(body);
    if (cookies.session !== undefined) {
      await this.auth.logout(cookies.session);
    }
    this.clear(response);
  }

  @Post('logout-all')
  @HttpCode(204)
  async logoutAll(
    @Req() request: HttpRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<void> {
    const { secret } = await this.context.required(this.context.read(request));
    this.context.requireCsrf(request, secret);
    parseNoBody(body);
    await this.auth.logoutAll(secret);
    this.clear(response);
  }

  @Post('password/change')
  @HttpCode(200)
  async changePassword(
    @Req() request: HttpRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<OpenedView> {
    const { secret, session } = await this.context.required(this.context.read(request));
    this.context.requireCsrf(request, secret);
    const input = parseTextFields(body, ['currentPassword', 'newPassword']);
    let opened: OpenedSession;
    try {
      opened = await this.limited.changePassword(session, secret, input.currentPassword, input.newPassword);
    } catch (error) {
      // A sessão continua válida: 401 levaria o cliente a descartá-la.
      if (error instanceof AuthenticationError && error.code === 'INVALID_CREDENTIALS') {
        throw new ProblemError('AUTH_CURRENT_PASSWORD_INVALID');
      }
      throw error;
    }
    return this.enter(response, opened);
  }

  private async login(
    request: HttpRequest,
    response: HttpResponse,
    attempt: () => Promise<OpenedSession>,
  ): Promise<OpenedView> {
    const cookies = this.context.read(request);
    const previous = await this.context.current(cookies);
    this.context.requireCsrf(request, previous?.secret ?? cookies.preauth);
    const opened = await attempt();
    if (previous !== null) {
      // Uma identidade por contexto: a sessão anterior deste contexto termina.
      await this.auth.logout(previous.secret);
    }
    return this.enter(response, opened);
  }

  /** Contexto renovado: novo segredo, novo token e fim do contexto pré-autenticado. */
  private enter(response: HttpResponse, opened: OpenedSession): OpenedView {
    this.context.cookies.setSession(response, opened.secret);
    this.context.cookies.clearPreauth(response);
    return { ...view(opened.session), csrfToken: csrfToken(opened.secret) };
  }

  private clear(response: HttpResponse): void {
    this.context.cookies.clearSession(response);
    this.context.cookies.clearPreauth(response);
  }
}
