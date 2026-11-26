import { describe, expect, it, vi } from 'vitest';
import {
  EnrollmentAccessLostError,
  EnrollmentService,
  type EnrollmentState,
  type EnrollmentStore,
  type EnrollmentWrite,
  EnrollmentWorkspaceArchivedError,
  EnrollmentWorkspaceNotFoundError,
} from '../../../src/enrollment/application/enrollment.service.js';
import { hashEnrollmentCode, normalizeEnrollmentCode } from '../../../src/enrollment/domain/enrollment-code.js';
import type { WorkspaceAccess } from '../../../src/identity/domain/workspace-access.js';

const WS = '11111111-1111-4111-8111-111111111111';
const access: WorkspaceAccess = { identityId: '22222222-2222-4222-8222-222222222222', workspaceId: WS, role: 'FACILITATOR' };

function store(state: EnrollmentState | null, write: EnrollmentWrite = { kind: 'WRITTEN', revision: 1 }) {
  return {
    state: vi.fn<EnrollmentStore['state']>().mockResolvedValue(state),
    write: vi.fn<EnrollmentStore['write']>().mockResolvedValue(write),
  };
}

describe('serviço de inscrição', () => {
  it('issue grava só o hash do código devolvido', async () => {
    const s = store({ modality: 'SHARED', currentHash: null, revision: 0 });
    const issued = await new EnrollmentService(s).issue(access, 'corr-0001');
    expect(issued).toMatchObject({ workspaceId: WS, active: true, revision: 1, required: true });
    expect(s.write).toHaveBeenCalledWith(access, hashEnrollmentCode(normalizeEnrollmentCode(issued.code) ?? ''), 'corr-0001');
    expect(JSON.stringify(s.write.mock.calls)).not.toContain(issued.code);
  });

  it('revoke grava sem hash e informa a situação', async () => {
    const s = store({ modality: 'ISOLATED', currentHash: null, revision: 3 }, { kind: 'UNCHANGED', revision: 3 });
    expect(await new EnrollmentService(s).revoke(access, 'corr-0001')).toEqual({ workspaceId: WS, active: false, revision: 3, required: false });
    expect(s.write).toHaveBeenCalledWith(access, null, 'corr-0001');
  });

  it.each<[EnrollmentWrite, new () => Error]>([
    [{ kind: 'DENIED' }, EnrollmentAccessLostError],
    [{ kind: 'ARCHIVED' }, EnrollmentWorkspaceArchivedError],
  ])('resultado %j vira erro tipado', async (write, type) => {
    const s = store({ modality: 'SHARED', currentHash: null, revision: 0 }, write);
    await expect(new EnrollmentService(s).issue(access, 'corr-0001')).rejects.toBeInstanceOf(type);
    await expect(new EnrollmentService(s).revoke(access, 'corr-0001')).rejects.toBeInstanceOf(type);
  });

  it('workspace inexistente é erro tipado, também na verificação', async () => {
    const service = new EnrollmentService(store(null));
    await expect(service.check(WS, null)).rejects.toBeInstanceOf(EnrollmentWorkspaceNotFoundError);
    await expect(service.issue(access, 'corr-0001')).rejects.toBeInstanceOf(EnrollmentWorkspaceNotFoundError);
  });

  it('check aplica a política sobre a situação vigente', async () => {
    const code = 'AB12-CD34-EF56';
    const s = store({ modality: 'SHARED', currentHash: hashEnrollmentCode('AB12CD34EF56'), revision: 2 });
    const service = new EnrollmentService(s);
    expect(await service.check(WS, code)).toBe('ACCEPTED');
    expect(await service.check(WS, null)).toBe('REQUIRED');
    expect(await service.check(WS, 'AB12-CD34-EF57')).toBe('INVALID');
  });
});
