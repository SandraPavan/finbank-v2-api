// Catálogo de defeitos educacionais (DEV-006). VAZIO por decisão: nenhum defeito executável.
// Cada defeito futuro exige história própria com contrato, ambientes permitidos, reversão e
// testes do comportamento correto e didático (rule 07, PD-08).
import { ENVIRONMENT_KINDS, type EnvironmentKind, InvalidEducationalConfigError } from './educational-mode.js';

export interface DefectDefinition {
  readonly id: string;
  /** Defeito que enfraquece autenticação, autorização, isolamento ou sigilo. Nunca em SHARED. */
  readonly affectsSecurity: boolean;
  readonly allowedEnvironments: readonly EnvironmentKind[];
}

export interface LabPreset {
  readonly labId: string;
  readonly defectIds: readonly string[];
}

export interface DefectCatalog {
  readonly defects: readonly DefectDefinition[];
  readonly labPresets: readonly LabPreset[];
}

/** Garante a integridade de um catálogo: ids únicos, ambientes conhecidos e presets coerentes. */
export function validateCatalog(catalog: DefectCatalog): DefectCatalog {
  const defectIds = new Set<string>();
  for (const defect of catalog.defects) {
    if (defect.id === '' || defectIds.has(defect.id)) {
      throw new InvalidEducationalConfigError('catálogo.defects', 'exige ids não vazios e únicos');
    }
    if (
      typeof defect.affectsSecurity !== 'boolean' ||
      defect.allowedEnvironments.length === 0 ||
      defect.allowedEnvironments.some((env) => !(ENVIRONMENT_KINDS as readonly string[]).includes(env))
    ) {
      throw new InvalidEducationalConfigError('catálogo.defects', 'exige affectsSecurity e ambientes conhecidos');
    }
    defectIds.add(defect.id);
  }
  const labIds = new Set<string>();
  for (const lab of catalog.labPresets) {
    if (lab.labId === '' || labIds.has(lab.labId)) {
      throw new InvalidEducationalConfigError('catálogo.labPresets', 'exige labIds não vazios e únicos');
    }
    if (lab.defectIds.some((id) => !defectIds.has(id))) {
      throw new InvalidEducationalConfigError('catálogo.labPresets', 'referencia defeito inexistente');
    }
    labIds.add(lab.labId);
  }
  return catalog;
}

export const DEFECT_CATALOG: DefectCatalog = validateCatalog(
  Object.freeze({
    defects: Object.freeze([]),
    labPresets: Object.freeze([]),
  }),
);
