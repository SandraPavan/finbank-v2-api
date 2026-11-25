import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, UseFilters } from '@nestjs/common';
import { IdentityProblemFilter } from '../../access/http/access-problems.js';
import { CurrentWorkspace } from '../../access/http/operation-context.js';
import { FacilitatorWorkspaceAccess, WORKSPACE_PARAM } from '../../http/access-policy.js';
import { parseNoBody } from '../../http/body.js';
import type { HttpRequest } from '../../http/http-types.js';
import { parsePage } from '../../http/page.js';
import { correlationIdOf } from '../../http/problem.js';
import type { WorkspaceAccess } from '../../identity/domain/workspace-access.js';
import { CustomerAdministrationService, type CustomerPage, type CustomerState } from '../application/customer-administration.service.js';

@Controller(`api/v1/facilitator/workspaces/:${WORKSPACE_PARAM}/customers`)
@FacilitatorWorkspaceAccess()
@UseFilters(IdentityProblemFilter)
export class FacilitatorCustomersController {
  constructor(private readonly customers: CustomerAdministrationService) {}

  @Get()
  list(@CurrentWorkspace() access: WorkspaceAccess, @Query() query: Record<string, unknown>): Promise<CustomerPage> {
    return this.customers.list(access, parsePage(query));
  }

  @Post(':customerId/disable')
  @HttpCode(200)
  disable(
    @CurrentWorkspace() access: WorkspaceAccess,
    @Param('customerId') customerId: unknown,
    @Body() body: unknown,
    @Req() request: HttpRequest,
  ): Promise<CustomerState> {
    parseNoBody(body);
    return this.customers.setState(access, customerId, 'DISABLED', correlationIdOf(request));
  }

  @Post(':customerId/enable')
  @HttpCode(200)
  enable(
    @CurrentWorkspace() access: WorkspaceAccess,
    @Param('customerId') customerId: unknown,
    @Body() body: unknown,
    @Req() request: HttpRequest,
  ): Promise<CustomerState> {
    parseNoBody(body);
    return this.customers.setState(access, customerId, 'ACTIVE', correlationIdOf(request));
  }
}
