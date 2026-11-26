import { type ArgumentsHost, Body, Catch, Controller, type ExceptionFilter, Get, Patch, Req, UseFilters } from '@nestjs/common';
import { IdentityProblemFilter } from '../../access/http/access-problems.js';
import { CurrentWorkspace } from '../../access/http/operation-context.js';
import { FacilitatorWorkspaceAccess, WORKSPACE_PARAM } from '../../http/access-policy.js';
import type { HttpRequest, HttpResponse } from '../../http/http-types.js';
import { correlationIdOf, type ProblemCode, ProblemError, sendProblem } from '../../http/problem.js';
import type { WorkspaceAccess } from '../../identity/domain/workspace-access.js';
import {
  ClockAccessLostError,
  ClockConflictError,
  type ClockView,
  ClockWorkspaceArchivedError,
  ClockWorkspaceNotFoundError,
  InvalidClockRequestError,
  parseClockChange,
  SimulationClockService,
} from '../application/simulation-clock.service.js';
import { InvalidBusinessDateError } from '../domain/business-date.js';

const CODES: [new (...args: never[]) => Error, ProblemCode][] = [
  [InvalidClockRequestError, 'VALIDATION_ERROR'],
  [InvalidBusinessDateError, 'CLOCK_DATE_INVALID'],
  [ClockConflictError, 'CLOCK_CONFLICT'],
  [ClockWorkspaceArchivedError, 'WORKSPACE_ARCHIVED'],
  [ClockAccessLostError, 'RESOURCE_NOT_FOUND'],
  [ClockWorkspaceNotFoundError, 'RESOURCE_NOT_FOUND'],
];

/** Erros do relógio sem detalhe: nunca o valor recebido. */
@Catch(InvalidClockRequestError, InvalidBusinessDateError, ClockConflictError, ClockWorkspaceArchivedError, ClockAccessLostError, ClockWorkspaceNotFoundError)
export class SimulationClockProblemFilter implements ExceptionFilter {
  catch(error: Error, host: ArgumentsHost): void {
    const code = CODES.find(([type]) => error instanceof type)?.[1] ?? 'INTERNAL_ERROR';
    const http = host.switchToHttp();
    sendProblem(http.getRequest<HttpRequest>(), http.getResponse<HttpResponse>(), new ProblemError(code));
  }
}

@Controller(`api/v1/facilitator/workspaces/:${WORKSPACE_PARAM}/clock`)
@FacilitatorWorkspaceAccess()
@UseFilters(IdentityProblemFilter, SimulationClockProblemFilter)
export class SimulationClockController {
  constructor(private readonly clock: SimulationClockService) {}

  @Get()
  read(@CurrentWorkspace() access: WorkspaceAccess): Promise<ClockView> {
    return this.clock.read(access);
  }

  @Patch()
  change(@CurrentWorkspace() access: WorkspaceAccess, @Body() body: unknown, @Req() request: HttpRequest): Promise<ClockView> {
    const { baseRevision, date } = parseClockChange(body);
    return this.clock.change(access, baseRevision, date, correlationIdOf(request));
  }
}
