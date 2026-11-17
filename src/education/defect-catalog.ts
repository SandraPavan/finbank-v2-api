// Catálogo de defeitos educacionais. VAZIO por decisão: nenhum defeito executável.
// Identificadores são opacos e não descrevem o defeito. Presets são indexados pelo
// SHA-256 do código do laboratório; o código em si nunca entra neste repositório.
import {
  CODE_HASH_PATTERN,
  ENVIRONMENT_KINDS,
  type EnvironmentKind,
  InvalidEducationalConfigError,
} from './educational-mode.js';

/** `d-` + 16 caracteres hexadecimais minúsculos. */
export const DEFECT_ID_PATTERN = /^d-[0-9a-f]{16}$/;

export interface DefectDefinition {
  readonly id: string;
  /** Enfraquece autenticação, autorização, isolamento ou sigilo. Nunca em SHARED. */
  readonly affectsSecurity: boolean;
  readonly allowedEnvironments: readonly EnvironmentKind[];
}

export interface LabPreset {
  /** SHA-256 (hex minúsculo) do código do laboratório. */
  readonly codeHash: string;
  readonly defectIds: readonly string[];
}

export interface DefectCatalog {
  readonly defects: readonly DefectDefinition[];
  readonly labPresets: readonly LabPreset[];
}

/** Garante a integridade de um catálogo: ids opacos e únicos, ambientes conhecidos e presets coerentes. */
export function validateCatalog(catalog: DefectCatalog): DefectCatalog {
  const defectIds = new Set<string>();
  for (const defect of catalog.defects) {
    if (!DEFECT_ID_PATTERN.test(defect.id) || defectIds.has(defect.id)) {
      throw new InvalidEducationalConfigError('catálogo.defects', 'exige ids opacos válidos e únicos');
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
  const codeHashes = new Set<string>();
  for (const lab of catalog.labPresets) {
    if (!CODE_HASH_PATTERN.test(lab.codeHash) || codeHashes.has(lab.codeHash)) {
      throw new InvalidEducationalConfigError('catálogo.labPresets', 'exige hashes SHA-256 válidos e únicos');
    }
    if (lab.defectIds.length === 0 || lab.defectIds.some((id) => !defectIds.has(id))) {
      throw new InvalidEducationalConfigError('catálogo.labPresets', 'exige defeitos existentes no catálogo');
    }
    codeHashes.add(lab.codeHash);
  }
  return catalog;
}

export const DEFECT_CATALOG: DefectCatalog = validateCatalog(
  Object.freeze({
    defects: Object.freeze([]),
    labPresets: Object.freeze([]),
  }),
);
