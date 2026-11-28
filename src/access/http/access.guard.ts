import { type CanActivate, type ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthContext } from '../../authentication/http/auth-context.js';
import { ACCESS_POLICY, type AccessPolicy, WORKSPACE_PARAM } from '../../http/access-policy.js';
import type { HttpRequest } from '../../http/http-types.js';
import { ProblemError } from '../../http/problem.js';
import { WorkspaceAccessService } from '../../identity/application/workspace-access.service.js';
import type { WorkspaceAccess } from '../../identity/domain/workspace-access.js';
import { accessProblem } from './access-problems.js';
import { setOperationContext } from './operation-context.js';

type RoutedRequest = HttpRequest & { readonly params: Readonly<Record<string, unknown>> };

const SAFE_METHODS = new Set(['GET', 'HEAD']);

/**
 * Guarda de todas as rotas. Ordem fixa: política, transporte e cookies, sessão, perfil, CSRF, workspace
 * (do caminho para o facilitador; da identidade para o cliente).
 * O vínculo é consultado a cada requisição. Escritas devem reconferi-lo na própria transação.
 */
@Injectable()
export class AccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthContext,
    private readonly access: WorkspaceAccessService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const policy = this.reflector.getAllAndOverride<AccessPolicy | undefined>(ACCESS_POLICY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (policy === undefined) {
      throw new ForbiddenException();
    }
    if (policy.kind !== 'PROFILE') {
      return true;
    }
    const request = context.switchToHttp().getRequest<RoutedRequest>();
    try {
      const { secret, session } = await this.auth.required(this.auth.read(request));
      if (session.profile !== policy.profile) {
        throw new ProblemError('ACCESS_DENIED');
      }
      if (!SAFE_METHODS.has(request.method)) {
        this.auth.requireCsrf(request, secret);
      }
      let workspace: WorkspaceAccess | null = null;
      if (policy.workspace || policy.profile === 'CUSTOMER') {
        // Cliente: o workspace da identidade, nunca um recebido; o caminho de uma rota de cliente não o informa.
        const requested = policy.profile === 'CUSTOMER' ? session.workspaceId : request.params[WORKSPACE_PARAM];
        workspace = await this.access.resolve(session.identityId, requested);
        if (workspace.role !== policy.profile) {
          throw new ProblemError('ACCESS_DENIED');
        }
      }
      setOperationContext(request, { session, workspace });
      return true;
    } catch (error) {
      throw accessProblem(error);
    }
  }
}
