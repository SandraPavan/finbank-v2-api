import { type ArgumentsHost, Body, Catch, Controller, type ExceptionFilter, Get, HttpCode, Param, Post, Req, UseFilters } from '@nestjs/common';
import { IdentityProblemFilter } from '../../access/http/access-problems.js';
import { CurrentWorkspace } from '../../access/http/operation-context.js';
import { FacilitatorWorkspaceAccess, WORKSPACE_PARAM } from '../../http/access-policy.js';
import type { HttpRequest, HttpResponse } from '../../http/http-types.js';
import { correlationIdOf, type ProblemCode, ProblemError, sendProblem } from '../../http/problem.js';
import type { WorkspaceAccess } from '../../identity/domain/workspace-access.js';
import {
  type AccountStateView,
  BankAccountError,
  type BankAccountErrorCode,
  BankAccountService,
  type CustomerAccountView,
} from '../application/bank-account.service.js';
import { InvalidJustificationError, parseJustification } from '../domain/account-status.js';

const CODES: Record<BankAccountErrorCode, ProblemCode> = {
  NOT_FOUND: 'RESOURCE_NOT_FOUND',
  ACCESS_LOST: 'RESOURCE_NOT_FOUND',
  WORKSPACE_ARCHIVED: 'WORKSPACE_ARCHIVED',
};

/** Erros da conta sem detalhe: nunca a justificativa recebida. */
@Catch(BankAccountError, InvalidJustificationError)
export class BankAccountProblemFilter implements ExceptionFilter {
  catch(error: BankAccountError | InvalidJustificationError, host: ArgumentsHost): void {
    const problem =
      error instanceof InvalidJustificationError ? new ProblemError('VALIDATION_ERROR', { fields: ['justification'] }) : new ProblemError(CODES[error.code]);
    const http = host.switchToHttp();
    sendProblem(http.getRequest<HttpRequest>(), http.getResponse<HttpResponse>(), problem);
  }
}

const CUSTOMER_PARAM = 'customerId';

/** Conta do cliente: consulta, bloqueio e desbloqueio pelo facilitador vinculado. O saldo nunca é tocado. */
@Controller(`api/v1/facilitator/workspaces/:${WORKSPACE_PARAM}/customers/:${CUSTOMER_PARAM}/account`)
@FacilitatorWorkspaceAccess()
@UseFilters(IdentityProblemFilter, BankAccountProblemFilter)
export class BankAccountController {
  constructor(private readonly accounts: BankAccountService) {}

  @Get()
  view(@CurrentWorkspace() access: WorkspaceAccess, @Param(CUSTOMER_PARAM) customerId: string): Promise<CustomerAccountView> {
    return this.accounts.view(access, customerId);
  }

  @Post('block')
  @HttpCode(200)
  block(@CurrentWorkspace() access: WorkspaceAccess, @Param(CUSTOMER_PARAM) customerId: string, @Body() body: unknown, @Req() request: HttpRequest): Promise<AccountStateView> {
    return this.accounts.change(access, customerId, 'BLOCKED', parseJustification(body), correlationIdOf(request));
  }

  @Post('unblock')
  @HttpCode(200)
  unblock(@CurrentWorkspace() access: WorkspaceAccess, @Param(CUSTOMER_PARAM) customerId: string, @Body() body: unknown, @Req() request: HttpRequest): Promise<AccountStateView> {
    return this.accounts.change(access, customerId, 'ACTIVE', parseJustification(body), correlationIdOf(request));
  }
}
