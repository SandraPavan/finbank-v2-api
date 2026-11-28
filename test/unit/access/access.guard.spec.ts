import { type ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { AccessGuard } from '../../../src/access/http/access.guard.js';
import { operationContext } from '../../../src/access/http/operation-context.js';
import { AuthenticationError } from '../../../src/authentication/domain/errors.js';
import type { AuthContext } from '../../../src/authentication/http/auth-context.js';
import { ACCESS_POLICY, type AccessPolicy } from '../../../src/http/access-policy.js';
import { ProblemError } from '../../../src/http/problem.js';
import type { WorkspaceAccessService } from '../../../src/identity/application/workspace-access.service.js';
import { IdentityError } from '../../../src/identity/domain/errors.js';

const SCOPED: AccessPolicy = { kind: 'PROFILE', profile: 'FACILITATOR', workspace: true };

function setup(policy: AccessPolicy | undefined, method = 'GET') {
  const steps: string[] = [];
  const step = <T>(name: string, value: T) =>
    vi.fn((): T => {
      steps.push(name);
      return value;
    });
  const session: { identityId: string; profile: string; workspaceId: string | null } = { identityId: 'i', profile: 'FACILITATOR', workspaceId: null };
  const auth = {
    read: step('transport', {}),
    required: step('session', { secret: 's', session }),
    requireCsrf: step('csrf', undefined),
  };
  const access = { resolve: step('workspace', { identityId: 'i', workspaceId: 'w', role: 'FACILITATOR' }) };
  const request = { method, originalUrl: '/', headers: {}, params: { workspaceId: 'w' } };
  const handler = () => undefined;
  if (policy !== undefined) {
    Reflect.defineMetadata(ACCESS_POLICY, policy, handler);
  }
  const context = {
    getHandler: () => handler, getClass: () => class {}, switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  const guard = new AccessGuard(new Reflector(), auth as unknown as AuthContext, access as unknown as WorkspaceAccessService);
  return { steps, session, auth, access, request, run: () => guard.canActivate(context) };
}

describe('AccessGuard', () => {
  it('nega rota sem política, sem consultar nada', async () => {
    const s = setup(undefined);
    await expect(s.run()).rejects.toBeInstanceOf(ForbiddenException);
    expect(s.steps).toEqual([]);
  });

  it.each(['PUBLIC', 'AUTHENTICATION'] as const)('%s passa sem contexto de operação', async (kind) => {
    const s = setup({ kind });
    await expect(s.run()).resolves.toBe(true);
    expect(s.steps).toEqual([]);
    expect(() => operationContext(s.request)).toThrow(ProblemError);
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'QUALQUER'])('%s: ordem fixa, com CSRF antes do workspace', async (method) => {
    const s = setup(SCOPED, method);
    await s.run();
    expect(s.steps).toEqual(['transport', 'session', 'csrf', 'workspace']);
    expect(operationContext(s.request).workspace).toMatchObject({ workspaceId: 'w' });
  });

  it.each(['GET', 'HEAD'])('%s dispensa CSRF', async (method) => {
    const s = setup(SCOPED, method);
    await s.run();
    expect(s.steps).toEqual(['transport', 'session', 'workspace']);
  });

  it('CSRF inválido não consulta o workspace nem cria contexto', async () => {
    const s = setup(SCOPED, 'POST');
    s.auth.requireCsrf.mockImplementation(() => {
      throw new ProblemError('CSRF_VALIDATION_FAILED');
    });
    await expect(s.run()).rejects.toMatchObject({ code: 'CSRF_VALIDATION_FAILED' });
    expect(s.access.resolve).not.toHaveBeenCalled();
    expect(() => operationContext(s.request)).toThrow(ProblemError);
  });

  it('perfil errado não confere CSRF nem workspace', async () => {
    const s = setup(SCOPED, 'POST');
    s.session.profile = 'CUSTOMER';
    await expect(s.run()).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    expect(s.steps).toEqual(['transport', 'session']);
  });

  it('papel devolvido diferente do exigido é negado', async () => {
    const s = setup(SCOPED);
    s.access.resolve.mockReturnValue({ identityId: 'i', workspaceId: 'w', role: 'CUSTOMER' });
    await expect(s.run()).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
  });

  it.each([
    ['ACCESS_DENIED', 'RESOURCE_NOT_FOUND'],
    ['INVALID_INPUT', 'RESOURCE_NOT_FOUND'],
    ['ACCESS_CHECK_FAILED', 'TEMPORARY_UNAVAILABLE'],
    ['INVALID_EMAIL', 'INTERNAL_ERROR'],
  ] as const)('identidade %s vira %s', async (from, to) => {
    const s = setup(SCOPED);
    s.access.resolve.mockImplementation(() => {
      throw new IdentityError(from);
    });
    await expect(s.run()).rejects.toMatchObject({ code: to, options: {} });
  });

  it.each([
    ['SESSION_INVALID', 'AUTH_SESSION_REQUIRED'],
    ['SESSION_EXPIRED', 'AUTH_SESSION_EXPIRED'],
    ['AUTHENTICATION_FAILED', 'TEMPORARY_UNAVAILABLE'],
  ] as const)('autenticação %s vira %s', async (from, to) => {
    const s = setup(SCOPED);
    s.auth.required.mockImplementation(() => {
      throw new AuthenticationError(from);
    });
    await expect(s.run()).rejects.toMatchObject({ code: to });
    expect(s.access.resolve).not.toHaveBeenCalled();
  });

  describe('rota de cliente', () => {
    const CUSTOMER: AccessPolicy = { kind: 'PROFILE', profile: 'CUSTOMER', workspace: false };
    const asCustomer = (method = 'GET') => {
      const s = setup(CUSTOMER, method);
      s.session.profile = 'CUSTOMER';
      s.session.workspaceId = 'w-da-identidade';
      s.request.params = { workspaceId: 'w-do-caminho' };
      s.access.resolve.mockImplementation(() => {
        s.steps.push('workspace');
        return { identityId: 'i', workspaceId: 'w-da-identidade', role: 'CUSTOMER' };
      });
      return s;
    };

    it('o workspace vem da sessão, nunca do caminho, e é reconferido', async () => {
      const s = asCustomer();
      await expect(s.run()).resolves.toBe(true);
      expect(s.steps).toEqual(['transport', 'session', 'workspace']);
      expect(s.access.resolve).toHaveBeenCalledWith('i', 'w-da-identidade');
      expect(operationContext(s.request).workspace).toMatchObject({ workspaceId: 'w-da-identidade', role: 'CUSTOMER' });
    });

    it('facilitador é recusado sem consultar o workspace', async () => {
      const s = setup(CUSTOMER);
      await expect(s.run()).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
      expect(s.access.resolve).not.toHaveBeenCalled();
    });

    it('cliente sem workspace na sessão ou com acesso negado não passa', async () => {
      const s = asCustomer();
      s.access.resolve.mockImplementation(() => {
        throw new IdentityError('ACCESS_DENIED');
      });
      await expect(s.run()).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
      expect(() => operationContext(s.request)).toThrow(ProblemError);
    });

    it('papel devolvido diferente de CUSTOMER é negado', async () => {
      const s = asCustomer();
      s.access.resolve.mockReturnValue({ identityId: 'i', workspaceId: 'w-da-identidade', role: 'FACILITATOR' });
      await expect(s.run()).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    });

    it('escrita de cliente confere CSRF antes do workspace', async () => {
      const s = asCustomer('POST');
      await s.run();
      expect(s.steps).toEqual(['transport', 'session', 'csrf', 'workspace']);
    });
  });
});
