import { type ArgumentsHost, Catch, Controller, Delete, type ExceptionFilter, HttpCode, Post, Req, UseFilters } from '@nestjs/common';
import { IdentityProblemFilter } from '../../access/http/access-problems.js';
import { CurrentWorkspace } from '../../access/http/operation-context.js';
import { FacilitatorWorkspaceAccess, WORKSPACE_PARAM } from '../../http/access-policy.js';
import type { HttpRequest, HttpResponse } from '../../http/http-types.js';
import { correlationIdOf, type ProblemCode, ProblemError, sendProblem } from '../../http/problem.js';
import type { WorkspaceAccess } from '../../identity/domain/workspace-access.js';
import {
  EnrollmentAccessLostError,
  EnrollmentService,
  type EnrollmentView,
  EnrollmentWorkspaceArchivedError,
  EnrollmentWorkspaceNotFoundError,
  type IssuedEnrollmentCode,
} from '../application/enrollment.service.js';

/** Erros da inscrição sem detalhe. */
@Catch(EnrollmentAccessLostError, EnrollmentWorkspaceArchivedError, EnrollmentWorkspaceNotFoundError)
export class EnrollmentProblemFilter implements ExceptionFilter {
  catch(error: Error, host: ArgumentsHost): void {
    const code: ProblemCode = error instanceof EnrollmentWorkspaceArchivedError ? 'WORKSPACE_ARCHIVED' : 'RESOURCE_NOT_FOUND';
    const http = host.switchToHttp();
    sendProblem(http.getRequest<HttpRequest>(), http.getResponse<HttpResponse>(), new ProblemError(code));
  }
}

@Controller(`api/v1/facilitator/workspaces/:${WORKSPACE_PARAM}/enrollment-code`)
@FacilitatorWorkspaceAccess()
@UseFilters(IdentityProblemFilter, EnrollmentProblemFilter)
export class EnrollmentController {
  constructor(private readonly enrollment: EnrollmentService) {}

  /** O código vai só nesta resposta (toda resposta da API já é `no-store`). */
  @Post()
  @HttpCode(200)
  issue(@CurrentWorkspace() access: WorkspaceAccess, @Req() request: HttpRequest): Promise<IssuedEnrollmentCode> {
    return this.enrollment.issue(access, correlationIdOf(request));
  }

  @Delete()
  revoke(@CurrentWorkspace() access: WorkspaceAccess, @Req() request: HttpRequest): Promise<EnrollmentView> {
    return this.enrollment.revoke(access, correlationIdOf(request));
  }
}
