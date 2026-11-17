// Catálogo FICTÍCIO, somente para testes: metadados sem comportamento, que não existem em src/.
// IDs e códigos foram gerados aleatoriamente para os testes e não correspondem a nenhum laboratório.
import { type DefectCatalog, validateCatalog } from '../../../src/education/defect-catalog.js';
import { hashLabCode } from '../../../src/education/educational-mode.js';

export const ID_A = 'd-fdf709b001bab397'; // affectsSecurity: false, ISOLATED e SHARED
export const ID_B = 'd-19a7160212a7780b'; // affectsSecurity: true, ISOLATED e SHARED
export const ID_C = 'd-20165e251bc626ad'; // affectsSecurity: false, só ISOLATED

export const CODE_1 = 'VBVQ-R4CD-6BRN'; // preset com ID_A e ID_B
export const CODE_2 = 'D57C-VSWN-YXR4'; // preset com ID_C
export const CODE_UNKNOWN = '8RUX-X33M-UL5F'; // formato válido, fora do catálogo

export const FIXTURE_CATALOG: DefectCatalog = validateCatalog({
  defects: [
    { id: ID_A, affectsSecurity: false, allowedEnvironments: ['ISOLATED', 'SHARED'] },
    { id: ID_B, affectsSecurity: true, allowedEnvironments: ['ISOLATED', 'SHARED'] },
    { id: ID_C, affectsSecurity: false, allowedEnvironments: ['ISOLATED'] },
  ],
  labPresets: [
    { codeHash: hashLabCode(CODE_1), defectIds: [ID_A, ID_B] },
    { codeHash: hashLabCode(CODE_2), defectIds: [ID_C] },
  ],
});
