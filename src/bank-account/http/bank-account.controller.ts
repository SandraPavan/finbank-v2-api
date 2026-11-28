import { type ArgumentsHost, Body, Catch, Controller, type ExceptionFilter, Get, HttpCode, Param, Post, Query, Req, Res, UseFilters } from '@nestjs/common';
import { IdentityProblemFilter } from '../../access/http/access-problems.js';
import { CurrentWorkspace } from '../../access/http/operation-context.js';
import { FacilitatorWorkspaceAccess, WORKSPACE_PARAM } from '../../http/access-policy.js';
import { type HttpRequest, type HttpResponse, header } from '../../http/http-types.js';
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
import { type CreditView, EducationalCreditError, type EducationalCreditErrorCode, EducationalCreditService } from '../application/educational-credit.service.js';
import { InvalidCreditRequestError } from '../domain/educational-credit.js';
import { InvalidStatementQueryError, StatementDataError } from '../domain/statement.js';
import { AccountStatementService, type StatementPage } from '../application/account-statement.service.js';

const CODES: Record<BankAccountErrorCode, ProblemCode> = {
  NOT_FOUND: 'RESOURCE_NOT_FOUND',
  ACCESS_LOST: 'RESOURCE_NOT_FOUND',
  WORKSPACE_ARCHIVED: 'WORKSPACE_ARCHIVED',
};

const CREDIT_CODES: Record<EducationalCreditErrorCode, ProblemCode> = {
  NOT_FOUND: 'RESOURCE_NOT_FOUND',
  ACCESS_LOST: 'RESOURCE_NOT_FOUND',
  WORKSPACE_ARCHIVED: 'WORKSPACE_ARCHIVED',
  ACCOUNT_BLOCKED: 'ACCOUNT_BLOCKED',
  LIMIT_EXCEEDED: 'CREDIT_LIMIT_EXCEEDED',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
};

type AccountProblem = BankAccountError | InvalidJustificationError | InvalidCreditRequestError | EducationalCreditError | InvalidStatementQueryError | StatementDataError;

function problemOf(error: AccountProblem): ProblemError {
  if (error instanceof InvalidStatementQueryError) {
    return new ProblemError('VALIDATION_ERROR', error.fields.length > 0 ? { fields: error.fields } : {});
  }
  if (error instanceof StatementDataError) {
    return new ProblemError('INTERNAL_ERROR');
  }
  if (error instanceof InvalidJustificationError) {
    return new ProblemError('VALIDATION_ERROR', { fields: ['justification'] });
  }
  if (error instanceof InvalidCreditRequestError) {
    return new ProblemError('VALIDATION_ERROR', error.fields.length > 0 ? { fields: error.fields } : {});
  }
  if (error instanceof EducationalCreditError) {
    return new ProblemError(CREDIT_CODES[error.code], error.code === 'LIMIT_EXCEEDED' ? { fields: ['amount'] } : {});
  }
  return new ProblemError(CODES[error.code]);
}

/** Erros da conta, do crédito e do extrato sem detalhe: nunca a justificativa, o valor, a chave ou o cursor recebidos. */
@Catch(BankAccountError, InvalidJustificationError, InvalidCreditRequestError, EducationalCreditError, InvalidStatementQueryError, StatementDataError)
export class BankAccountProblemFilter implements ExceptionFilter {
  catch(error: AccountProblem, host: ArgumentsHost): void {
    const problem = problemOf(error);
    const http = host.switchToHttp();
    sendProblem(http.getRequest<HttpRequest>(), http.getResponse<HttpResponse>(), problem);
  }
}

const CUSTOMER_PARAM = 'customerId';

/** Conta do cliente pelo facilitador vinculado: consulta com saldo, extrato, bloqueio, desbloqueio e crédito educacional. */
@Controller(`api/v1/facilitator/workspaces/:${WORKSPACE_PARAM}/customers/:${CUSTOMER_PARAM}/account`)
@FacilitatorWorkspaceAccess()
@UseFilters(IdentityProblemFilter, BankAccountProblemFilter)
export class BankAccountController {
  constructor(
    private readonly accounts: BankAccountService,
    private readonly credits: EducationalCreditService,
    private readonly statements: AccountStatementService,
  ) {}

  @Get()
  view(@CurrentWorkspace() access: WorkspaceAccess, @Param(CUSTOMER_PARAM) customerId: string): Promise<CustomerAccountView> {
    return this.accounts.view(access, customerId);
  }

  /** Extrato da conta do cliente, somente leitura. */
  @Get('statement')
  statement(@CurrentWorkspace() access: WorkspaceAccess, @Param(CUSTOMER_PARAM) customerId: string, @Query() query: Record<string, unknown>): Promise<StatementPage> {
    return this.statements.customerStatement(access, customerId, query);
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

  /** Crédito educacional: 201 quando novo, 200 quando é a repetição da mesma chave e do mesmo conteúdo. */
  @Post('educational-credits')
  async credit(
    @CurrentWorkspace() access: WorkspaceAccess,
    @Param(CUSTOMER_PARAM) customerId: string,
    @Body() body: unknown,
    @Req() request: HttpRequest,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<CreditView> {
    const view = await this.credits.credit(access, customerId, header(request, 'idempotency-key'), body, correlationIdOf(request));
    response.status(view.replayed ? 200 : 201);
    return view;
  }
}
