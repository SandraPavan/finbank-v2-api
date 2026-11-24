import { Controller, Get, Query, UseFilters } from '@nestjs/common';
import type { ActiveSession } from '../../authentication/domain/session.js';
import { FacilitatorAccess, FacilitatorWorkspaceAccess, WORKSPACE_PARAM } from '../../http/access-policy.js';
import { parsePage } from '../../http/page.js';
import type { WorkspaceSummary } from '../../identity/application/facilitator-workspaces.reader.js';
import { FacilitatorWorkspacesService, type WorkspacePage } from '../../identity/application/facilitator-workspaces.service.js';
import type { WorkspaceAccess } from '../../identity/domain/workspace-access.js';
import { IdentityProblemFilter } from './access-problems.js';
import { CurrentSession, CurrentWorkspace } from './operation-context.js';

@Controller('api/v1/facilitator/workspaces')
@UseFilters(IdentityProblemFilter)
export class FacilitatorWorkspacesController {
  constructor(private readonly workspaces: FacilitatorWorkspacesService) {}

  @Get()
  @FacilitatorAccess()
  list(@CurrentSession() session: ActiveSession, @Query() query: Record<string, unknown>): Promise<WorkspacePage> {
    return this.workspaces.list(session.identityId, parsePage(query));
  }

  @Get(`:${WORKSPACE_PARAM}`)
  @FacilitatorWorkspaceAccess()
  find(@CurrentWorkspace() access: WorkspaceAccess): Promise<WorkspaceSummary> {
    return this.workspaces.find(access);
  }
}
