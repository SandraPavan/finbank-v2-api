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
/** `AAAA.MM.N`: ano, mês e sequência. Comparada por igualdade. */
export const CATALOG_VERSION_PATTERN = /^[0-9]{4}\.(0[1-9]|1[0-2])\.[1-9][0-9]{0,3}$/;
/** Chave pública e estável de uma operação da aplicação. */
export const OPERATION_KEY_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/;

/**
 * Operações em que um defeito pode se manifestar. Vazia: cada operação entra com o caso de uso
 * que a implementa, na história correspondente.
 */
export const OPERATION_KEYS: readonly string[] = Object.freeze([]);

export interface DefectDefinition {
  readonly id: string;
  /** Enfraquece autenticação, autorização, isolamento ou sigilo. Nunca em SHARED. */
  readonly affectsSecurity: boolean;
  readonly allowedEnvironments: readonly EnvironmentKind[];
  /** Operações afetadas; ao menos uma. */
  readonly operations: readonly string[];
  /** Defeitos que não podem estar ativos junto com este (relação simétrica). */
  readonly incompatibleWith: readonly string[];
}

export interface LabPreset {
  /** SHA-256 (hex minúsculo) do código do laboratório. */
  readonly codeHash: string;
  readonly defectIds: readonly string[];
}

export interface DefectCatalog {
  readonly version: string;
  readonly operations: readonly string[];
  readonly defects: readonly DefectDefinition[];
  readonly labPresets: readonly LabPreset[];
}

/** Algum par da lista é incompatível? Independe da ordem. */
export function hasIncompatiblePair(ids: readonly string[], catalog: DefectCatalog): boolean {
  const chosen = new Set(ids);
  return catalog.defects.some((defect) => chosen.has(defect.id) && defect.incompatibleWith.some((other) => chosen.has(other)));
}

function fail(field: string, rule: string): never {
  throw new InvalidEducationalConfigError(field, rule);
}

/** Garante a integridade de um catálogo: versão, operações, ids, ambientes, compatibilidade e presets. */
export function validateCatalog(catalog: DefectCatalog): DefectCatalog {
  if (typeof catalog.version !== 'string' || !CATALOG_VERSION_PATTERN.test(catalog.version)) {
    fail('catálogo.version', 'deve seguir AAAA.MM.N');
  }
  const operations = new Set<string>();
  for (const operation of catalog.operations) {
    if (typeof operation !== 'string' || !OPERATION_KEY_PATTERN.test(operation) || operations.has(operation)) {
      fail('catálogo.operations', 'exige chaves válidas e únicas');
    }
    operations.add(operation);
  }
  const defects = new Map<string, DefectDefinition>();
  for (const defect of catalog.defects) {
    if (!DEFECT_ID_PATTERN.test(defect.id) || defects.has(defect.id)) {
      fail('catálogo.defects', 'exige ids opacos válidos e únicos');
    }
    if (
      typeof defect.affectsSecurity !== 'boolean' ||
      defect.allowedEnvironments.length === 0 ||
      defect.allowedEnvironments.some((env) => !(ENVIRONMENT_KINDS as readonly string[]).includes(env))
    ) {
      fail('catálogo.defects', 'exige affectsSecurity e ambientes conhecidos');
    }
    if (defect.operations.length === 0 || new Set(defect.operations).size !== defect.operations.length || defect.operations.some((op) => !operations.has(op))) {
      fail('catálogo.defects', 'exige operações do catálogo, sem repetição');
    }
    defects.set(defect.id, defect);
  }
  for (const defect of catalog.defects) {
    for (const other of defect.incompatibleWith) {
      const peer = defects.get(other);
      if (other === defect.id || peer === undefined || !peer.incompatibleWith.includes(defect.id)) {
        fail('catálogo.defects', 'exige incompatibilidades simétricas entre defeitos existentes');
      }
    }
    if (new Set(defect.incompatibleWith).size !== defect.incompatibleWith.length) {
      fail('catálogo.defects', 'exige incompatibilidades sem repetição');
    }
  }
  const codeHashes = new Set<string>();
  for (const lab of catalog.labPresets) {
    if (!CODE_HASH_PATTERN.test(lab.codeHash) || codeHashes.has(lab.codeHash)) {
      fail('catálogo.labPresets', 'exige hashes SHA-256 válidos e únicos');
    }
    if (lab.defectIds.length === 0 || lab.defectIds.some((id) => !defects.has(id))) {
      fail('catálogo.labPresets', 'exige defeitos existentes no catálogo');
    }
    if (new Set(lab.defectIds).size !== lab.defectIds.length || hasIncompatiblePair(lab.defectIds, catalog)) {
      fail('catálogo.labPresets', 'exige defeitos compatíveis e sem repetição');
    }
    codeHashes.add(lab.codeHash);
  }
  return catalog;
}

export const DEFECT_CATALOG: DefectCatalog = validateCatalog(
  Object.freeze({
    version: '2026.11.1',
    operations: OPERATION_KEYS,
    defects: Object.freeze([]),
    labPresets: Object.freeze([]),
  }),
);
