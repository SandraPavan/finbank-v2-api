// Catálogo FICTÍCIO, somente para testes: metadados sem comportamento, que não existem em src/.
// IDs, operações e códigos foram gerados para os testes e não correspondem a nenhum laboratório.
import type { WorkspaceAccess } from '../../../src/identity/domain/workspace-access.js';
import { type DefectCatalog, validateCatalog } from '../../../src/education/defect-catalog.js';
import { hashLabCode } from '../../../src/education/educational-mode.js';

export const OP_X = 'FICTITIOUS_OPERATION_X';
export const OP_Y = 'FICTITIOUS_OPERATION_Y';

export const ID_A = 'd-fdf709b001bab397'; // affectsSecurity: false, ISOLATED e SHARED, operação X
export const ID_B = 'd-19a7160212a7780b'; // affectsSecurity: true, ISOLATED e SHARED, operação Y
export const ID_C = 'd-20165e251bc626ad'; // affectsSecurity: false, só ISOLATED, operações X e Y
export const ID_D = 'd-7c2e95a40f13b866'; // affectsSecurity: false, só ISOLATED, incompatível com C

export const CODE_1 = 'VBVQ-R4CD-6BRN'; // preset com ID_A e ID_B
export const CODE_2 = 'D57C-VSWN-YXR4'; // preset com ID_C
export const CODE_UNKNOWN = '8RUX-X33M-UL5F'; // formato válido, fora do catálogo

export const VERSION = '2026.01.7';

export const FIXTURE_CATALOG: DefectCatalog = validateCatalog({
  version: VERSION,
  operations: [OP_X, OP_Y],
  defects: [
    { id: ID_A, affectsSecurity: false, allowedEnvironments: ['ISOLATED', 'SHARED'], operations: [OP_X], incompatibleWith: [] },
    { id: ID_B, affectsSecurity: true, allowedEnvironments: ['ISOLATED', 'SHARED'], operations: [OP_Y], incompatibleWith: [] },
    { id: ID_C, affectsSecurity: false, allowedEnvironments: ['ISOLATED'], operations: [OP_X, OP_Y], incompatibleWith: [ID_D] },
    { id: ID_D, affectsSecurity: false, allowedEnvironments: ['ISOLATED'], operations: [OP_Y], incompatibleWith: [ID_C] },
  ],
  labPresets: [
    { codeHash: hashLabCode(CODE_1), defectIds: [ID_A, ID_B] },
    { codeHash: hashLabCode(CODE_2), defectIds: [ID_C] },
  ],
});

/** Mesmo catálogo sem o par incompatível: ALL é escolhível em ISOLATED. */
export const COMPATIBLE_CATALOG: DefectCatalog = validateCatalog({
  ...FIXTURE_CATALOG,
  defects: FIXTURE_CATALOG.defects.filter((d) => d.id !== ID_D).map((d) => ({ ...d, incompatibleWith: [] })),
});

export const WS_A = '11111111-1111-4111-8111-111111111111';
export const WS_B = '22222222-2222-4222-8222-222222222222';

export const access = (role: string, workspaceId = WS_A): WorkspaceAccess =>
  ({ identityId: '33333333-3333-4333-8333-333333333333', workspaceId, role }) as WorkspaceAccess;
