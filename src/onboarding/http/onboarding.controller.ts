import { type ArgumentsHost, Body, Catch, Controller, type ExceptionFilter, HttpCode, Post, Req, UseFilters } from '@nestjs/common';
import { IdentityProblemFilter } from '../../access/http/access-problems.js';
import { AuthContext } from '../../authentication/http/auth-context.js';
import { AuthenticationProblemFilter } from '../../authentication/http/authentication-problem.filter.js';
import { AuthenticationAccess } from '../../http/access-policy.js';
import type { HttpRequest, HttpResponse } from '../../http/http-types.js';
import { type ProblemCode, ProblemError, sendProblem } from '../../http/problem.js';
import { OnboardingError, type OnboardingErrorCode, OnboardingService, type SubmittedOnboarding } from '../application/onboarding.service.js';
import { OnboardingValidationError, parseOnboardingRequest } from '../domain/onboarding-request.js';

const CODES: Record<OnboardingErrorCode, ProblemCode> = {
  WORKSPACE_NOT_FOUND: 'RESOURCE_NOT_FOUND',
  WORKSPACE_ARCHIVED: 'WORKSPACE_ARCHIVED',
  ENROLLMENT_CODE_REQUIRED: 'ENROLLMENT_CODE_REQUIRED',
  ENROLLMENT_CODE_INVALID: 'ENROLLMENT_CODE_INVALID',
  UNDERAGE: 'ONBOARDING_UNDERAGE',
  DUPLICATE: 'ONBOARDING_DUPLICATE',
};

/** Só códigos e nomes de campos: nunca CPF, e-mail, telefone, nome, senha ou código de inscrição. */
@Catch(OnboardingValidationError, OnboardingError)
export class OnboardingProblemFilter implements ExceptionFilter {
  catch(error: OnboardingValidationError | OnboardingError, host: ArgumentsHost): void {
    const problem =
      error instanceof OnboardingValidationError
        ? new ProblemError('VALIDATION_ERROR', error.fields.length > 0 ? { fields: error.fields } : {})
        : new ProblemError(CODES[error.code], error.code === 'DUPLICATE' ? { fields: error.fields } : {});
    const http = host.switchToHttp();
    sendProblem(http.getRequest<HttpRequest>(), http.getResponse<HttpResponse>(), problem);
  }
}

/** Sem sessão: usa o contexto de pré-autenticação do login (`GET /auth/csrf`). Não abre sessão. */
@Controller('api/v1/onboarding/requests')
@AuthenticationAccess()
@UseFilters(IdentityProblemFilter, AuthenticationProblemFilter, OnboardingProblemFilter)
export class OnboardingController {
  constructor(
    private readonly onboarding: OnboardingService,
    private readonly context: AuthContext,
  ) {}

  @Post()
  @HttpCode(201)
  async submit(@Req() request: HttpRequest, @Body() body: unknown): Promise<SubmittedOnboarding> {
    const cookies = this.context.read(request);
    const current = await this.context.current(cookies);
    if (current !== null && current.session.scope !== 'NORMAL') {
      throw new ProblemError('PASSWORD_CHANGE_REQUIRED');
    }
    this.context.requireCsrf(request, current?.secret ?? cookies.preauth);
    return this.onboarding.submit(parseOnboardingRequest(body));
  }
}
