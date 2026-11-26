import { type ArgumentsHost, Body, Catch, Controller, type ExceptionFilter, Get, Patch, Req, UseFilters } from '@nestjs/common';
import { IdentityProblemFilter } from '../../access/http/access-problems.js';
import { CurrentWorkspace } from '../../access/http/operation-context.js';
import { FacilitatorWorkspaceAccess, WORKSPACE_PARAM } from '../../http/access-policy.js';
import type { HttpRequest, HttpResponse } from '../../http/http-types.js';
import { correlationIdOf, type ProblemCode, ProblemError, sendProblem } from '../../http/problem.js';
import type { WorkspaceAccess } from '../../identity/domain/workspace-access.js';
import {
  ConfigurationAccessLostError,
  ConfigurationConflictError,
  EducationalConfigService,
  type EducationalView,
  InvalidRequestError,
  parseChangeRequest,
} from '../application/educational-config.service.js';
import { EducationalAuthorizationError, InvalidEducationalConfigError } from '../educational-mode.js';

/** Erros do domínio educacional sem detalhe: nunca o campo, o valor, o código ou o hash. */
@Catch(InvalidEducationalConfigError, EducationalAuthorizationError, ConfigurationConflictError, ConfigurationAccessLostError)
export class EducationalProblemFilter implements ExceptionFilter {
  catch(error: Error, host: ArgumentsHost): void {
    let code: ProblemCode = 'EDUCATIONAL_CONFIG_INVALID';
    if (error instanceof InvalidRequestError) {
      code = 'VALIDATION_ERROR';
    } else if (error instanceof ConfigurationConflictError) {
      code = 'CONFIGURATION_CONFLICT';
    } else if (error instanceof ConfigurationAccessLostError) {
      code = 'RESOURCE_NOT_FOUND';
    } else if (error instanceof EducationalAuthorizationError) {
      code = error.reason === 'WORKSPACE_MISMATCH' ? 'RESOURCE_NOT_FOUND' : 'ACCESS_DENIED';
    }
    const http = host.switchToHttp();
    sendProblem(http.getRequest<HttpRequest>(), http.getResponse<HttpResponse>(), new ProblemError(code));
  }
}

@Controller(`api/v1/facilitator/workspaces/:${WORKSPACE_PARAM}/flags`)
@FacilitatorWorkspaceAccess()
@UseFilters(IdentityProblemFilter, EducationalProblemFilter)
export class EducationalConfigController {
  constructor(private readonly config: EducationalConfigService) {}

  @Get()
  read(@CurrentWorkspace() access: WorkspaceAccess): Promise<EducationalView> {
    return this.config.read(access);
  }

  @Patch()
  change(@CurrentWorkspace() access: WorkspaceAccess, @Body() body: unknown, @Req() request: HttpRequest): Promise<EducationalView> {
    const { baseRevision, configuration } = parseChangeRequest(body);
    return this.config.change(access, baseRevision, configuration, correlationIdOf(request));
  }
}
