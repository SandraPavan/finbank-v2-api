import { Controller, Get, Query, UseFilters } from '@nestjs/common';
import { IdentityProblemFilter } from '../../access/http/access-problems.js';
import { CurrentWorkspace } from '../../access/http/operation-context.js';
import { CustomerAccess } from '../../http/access-policy.js';
import type { WorkspaceAccess } from '../../identity/domain/workspace-access.js';
import { AccountStatementService, type OwnAccountView, type StatementPage } from '../application/account-statement.service.js';
import { InvalidStatementQueryError } from '../domain/statement.js';
import { BankAccountProblemFilter } from './bank-account.controller.js';

/**
 * Conta do próprio cliente, somente leitura. A conta é a da identidade confirmada pela guarda:
 * nenhum identificador de cliente, conta ou workspace é recebido.
 */
@Controller('api/v1/accounts/me')
@CustomerAccess()
@UseFilters(IdentityProblemFilter, BankAccountProblemFilter)
export class CustomerAccountController {
  constructor(private readonly statements: AccountStatementService) {}

  @Get()
  account(@CurrentWorkspace() access: WorkspaceAccess, @Query() query: Record<string, unknown>): Promise<OwnAccountView> {
    rejectQuery(query);
    return this.statements.ownAccount(access);
  }

  @Get('statement')
  statement(@CurrentWorkspace() access: WorkspaceAccess, @Query() query: Record<string, unknown>): Promise<StatementPage> {
    return this.statements.ownStatement(access, query);
  }
}

/** A conta própria não aceita parâmetros: qualquer um é recusado, em vez de ignorado. */
function rejectQuery(query: Record<string, unknown>): void {
  if (Object.keys(query).length > 0) {
    throw new InvalidStatementQueryError([]);
  }
}
