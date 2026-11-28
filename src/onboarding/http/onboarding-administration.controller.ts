import { type ArgumentsHost, Body, Catch, Controller, type ExceptionFilter, Get, HttpCode, Param, Patch, Post, Query, Req, UseFilters } from '@nestjs/common';
import { IdentityProblemFilter } from '../../access/http/access-problems.js';
import { CurrentWorkspace } from '../../access/http/operation-context.js';
import { FacilitatorWorkspaceAccess, WORKSPACE_PARAM } from '../../http/access-policy.js';
import type { HttpRequest, HttpResponse } from '../../http/http-types.js';
import { parsePage } from '../../http/page.js';
import { correlationIdOf, type ProblemCode, ProblemError, sendProblem } from '../../http/problem.js';
import type { WorkspaceAccess } from '../../identity/domain/workspace-access.js';
import {
  type DecisionView,
  OnboardingAdministrationError,
  type OnboardingAdministrationErrorCode,
  OnboardingAdministrationService,
  type OnboardingRequestPage,
  type PolicyView,
} from '../application/onboarding-administration.service.js';

const CODES: Record<OnboardingAdministrationErrorCode, ProblemCode> = {
  INVALID_REQUEST: 'VALIDATION_ERROR',
  POLICY_CONFLICT: 'ONBOARDING_POLICY_CONFLICT',
  ACCESS_LOST: 'RESOURCE_NOT_FOUND',
  WORKSPACE_ARCHIVED: 'WORKSPACE_ARCHIVED',
  REQUEST_NOT_FOUND: 'RESOURCE_NOT_FOUND',
  ALREADY_DECIDED: 'ONBOARDING_ALREADY_DECIDED',
  DUPLICATE: 'ONBOARDING_DUPLICATE',
};

/** Erros da administração do onboarding, sem valores recebidos. */
@Catch(OnboardingAdministrationError)
export class OnboardingAdministrationProblemFilter implements ExceptionFilter<OnboardingAdministrationError> {
  catch(error: OnboardingAdministrationError, host: ArgumentsHost): void {
    const options = error.code === 'DUPLICATE' ? { fields: ['email'] } : {};
    const http = host.switchToHttp();
    sendProblem(http.getRequest<HttpRequest>(), http.getResponse<HttpResponse>(), new ProblemError(CODES[error.code], options));
  }
}

const REQUEST_PARAM = 'requestId';

/** Política de aprovação e decisão das solicitações, pelo facilitador vinculado ao workspace do caminho. */
@Controller(`api/v1/facilitator/workspaces/:${WORKSPACE_PARAM}`)
@FacilitatorWorkspaceAccess()
@UseFilters(IdentityProblemFilter, OnboardingAdministrationProblemFilter)
export class OnboardingAdministrationController {
  constructor(private readonly administration: OnboardingAdministrationService) {}

  @Get('onboarding-policy')
  policy(@CurrentWorkspace() access: WorkspaceAccess): Promise<PolicyView> {
    return this.administration.policy(access);
  }

  @Patch('onboarding-policy')
  changePolicy(@CurrentWorkspace() access: WorkspaceAccess, @Body() body: unknown, @Req() request: HttpRequest): Promise<PolicyView> {
    return this.administration.changePolicy(access, body, correlationIdOf(request));
  }

  @Get('onboarding-requests')
  list(@CurrentWorkspace() access: WorkspaceAccess, @Query() query: Record<string, unknown>): Promise<OnboardingRequestPage> {
    const { status, ...rest } = query;
    if (Array.isArray(status)) {
      throw new ProblemError('VALIDATION_ERROR', { fields: ['status'] });
    }
    return this.administration.list(access, status, parsePage(rest));
  }

  @Post(`onboarding-requests/:${REQUEST_PARAM}/approve`)
  @HttpCode(200)
  approve(@CurrentWorkspace() access: WorkspaceAccess, @Param(REQUEST_PARAM) requestId: string, @Req() request: HttpRequest): Promise<DecisionView> {
    return this.administration.decide(access, requestId, 'APPROVED', correlationIdOf(request));
  }

  @Post(`onboarding-requests/:${REQUEST_PARAM}/reject`)
  @HttpCode(200)
  reject(@CurrentWorkspace() access: WorkspaceAccess, @Param(REQUEST_PARAM) requestId: string, @Req() request: HttpRequest): Promise<DecisionView> {
    return this.administration.decide(access, requestId, 'REJECTED', correlationIdOf(request));
  }
}
