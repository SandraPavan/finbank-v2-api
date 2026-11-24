import { describe, expect, it, vi } from 'vitest';
import { WorkspaceAccessService } from '../../../src/identity/application/workspace-access.service.js';
import { IdentityError } from '../../../src/identity/domain/errors.js';

const IDENTITY = '11111111-1111-4111-8111-111111111111';
const WORKSPACE = '22222222-2222-4222-8222-222222222222';

function service(result: () => Promise<string | null>) {
  const findActiveRole = vi.fn(result);
  return { findActiveRole, access: new WorkspaceAccessService({ findActiveRole }) };
}

describe('WorkspaceAccessService', () => {
  it.each(['CUSTOMER', 'FACILITATOR'])('devolve o papel %s do vínculo', async (role) => {
    const { access, findActiveRole } = service(() => Promise.resolve(role));
    const result = await access.resolve(IDENTITY, WORKSPACE);
    expect(result).toEqual({ identityId: IDENTITY, workspaceId: WORKSPACE, role });
    expect(Object.isFrozen(result)).toBe(true);
    expect(findActiveRole).toHaveBeenCalledExactlyOnceWith(IDENTITY, WORKSPACE);
  });

  it('nega quando não há vínculo ativo', async () => {
    const { access } = service(() => Promise.resolve(null));
    await expect(access.resolve(IDENTITY, WORKSPACE)).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
  });

  const invalid: unknown[] = [
    undefined, null, 1, {}, [IDENTITY], '', ` ${IDENTITY}`, `${IDENTITY}\n`,
    'ABCDEFAB-1111-4111-8111-111111111111', "' OR 1=1 --",
  ];
  it.each(invalid)('recusa identificador inválido sem consultar a porta: %j', async (raw) => {
    const { access, findActiveRole } = service(() => Promise.resolve('FACILITATOR'));
    for (const [identity, workspace] of [[raw, WORKSPACE], [IDENTITY, raw]]) {
      const error = await access.resolve(identity, workspace).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(IdentityError);
      expect(error).toMatchObject({
        code: 'INVALID_INPUT',
        message: 'Entrada inválida: identificadores devem ser UUID em minúsculas.',
      });
    }
    expect(findActiveRole).not.toHaveBeenCalled();
  });

  it('falha da porta não concede acesso', async () => {
    const { access } = service(() => Promise.reject(new IdentityError('ACCESS_CHECK_FAILED', '08006')));
    await expect(access.resolve(IDENTITY, WORKSPACE)).rejects.toMatchObject({ code: 'ACCESS_CHECK_FAILED' });
  });

  it.each(['', 'customer', 'STUDENT', 'ADMIN'])('papel desconhecido (%j) não concede acesso', async (role) => {
    const { access } = service(() => Promise.resolve(role));
    await expect(access.resolve(IDENTITY, WORKSPACE)).rejects.toMatchObject({ code: 'ACCESS_CHECK_FAILED' });
  });

  it('código técnico fora da allowlist é descartado', () => {
    expect(new IdentityError('ACCESS_CHECK_FAILED', '08006').technicalCode).toBe('08006');
    expect(new IdentityError('ACCESS_CHECK_FAILED', 'host=db senha').technicalCode).toBeUndefined();
  });
});
