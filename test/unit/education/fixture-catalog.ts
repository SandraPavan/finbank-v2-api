// Catálogo FICTÍCIO, somente para testes: metadados sem comportamento, que não existem em src/.
// Serve para provar a filtragem do ALL, dos presets e da política de ambiente.
import { type DefectCatalog, validateCatalog } from '../../../src/education/defect-catalog.js';

export const FIXTURE_CATALOG: DefectCatalog = validateCatalog({
  defects: [
    { id: 'fixture-functional', affectsSecurity: false, allowedEnvironments: ['ISOLATED', 'SHARED'] },
    { id: 'fixture-security', affectsSecurity: true, allowedEnvironments: ['ISOLATED', 'SHARED'] },
    { id: 'fixture-isolated-only', affectsSecurity: false, allowedEnvironments: ['ISOLATED'] },
  ],
  labPresets: [
    { labId: 'lab-fixture-a', defectIds: ['fixture-functional', 'fixture-security'] },
    { labId: 'lab-fixture-b', defectIds: ['fixture-isolated-only'] },
  ],
});
