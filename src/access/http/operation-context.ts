import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { ActiveSession } from '../../authentication/domain/session.js';
import type { HttpRequest } from '../../http/http-types.js';
import { ProblemError } from '../../http/problem.js';
import type { WorkspaceAccess } from '../../identity/domain/workspace-access.js';

/** O que a guarda confirmou para a requisição. */
export interface OperationContext {
  readonly session: ActiveSession;
  readonly workspace: WorkspaceAccess | null;
}

// Fora do objeto da requisição: nenhum dado recebido consegue preencher este contexto.
const CONTEXTS = new WeakMap<object, OperationContext>();

export function setOperationContext(request: HttpRequest, context: OperationContext): void {
  CONTEXTS.set(request, Object.freeze(context));
}

/** Sem contexto confirmado, nega. */
export function operationContext(request: HttpRequest): OperationContext {
  const context = CONTEXTS.get(request);
  if (context === undefined) {
    throw new ProblemError('ACCESS_DENIED');
  }
  return context;
}

export const CurrentSession = createParamDecorator(
  (_: unknown, context: ExecutionContext): ActiveSession => operationContext(context.switchToHttp().getRequest<HttpRequest>()).session,
);

/** Acesso confirmado ao workspace do caminho; a rota nunca lê o identificador recebido. */
export const CurrentWorkspace = createParamDecorator((_: unknown, context: ExecutionContext): WorkspaceAccess => {
  const { workspace } = operationContext(context.switchToHttp().getRequest<HttpRequest>());
  if (workspace === null) {
    throw new ProblemError('ACCESS_DENIED');
  }
  return workspace;
});
