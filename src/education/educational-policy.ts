// Política de segurança, resolução, alteração e avaliação por operação da configuração educacional.
import { type DefectCatalog, type DefectDefinition, hasIncompatiblePair } from './defect-catalog.js';
import {
  type Actor,
  EducationalAuthorizationError,
  type EducationalMode,
  type EnvironmentKind,
  InvalidEducationalConfigError,
  parseConfigChange,
  parseOperation,
  PRESET_ALL,
  PRESET_NONE,
  type Preset,
  parseWorkspaceId,
  type WorkspaceEducationalConfig,
} from './educational-mode.js';

/** Visão de leitura do preset: indica o tipo, sem expor o hash do código. */
export type ResolvedPreset = { readonly kind: 'NONE' } | { readonly kind: 'ALL' } | { readonly kind: 'LAB' };

export interface ResolvedEducationalConfig {
  readonly workspaceId: string;
  readonly revision: number;
  readonly catalogVersion: string;
  /** A revisão foi criada com outra versão do catálogo: nenhum defeito vale até nova escolha. */
  readonly stale: boolean;
  readonly mode: EducationalMode;
  readonly preset: ResolvedPreset | null;
  /** Defeitos efetivamente executáveis, na ordem do catálogo. Com o catálogo atual, sempre vazio. */
  readonly enabledDefectIds: readonly string[];
}

/** Segurança em ambiente compartilhado prevalece sobre qualquer modo ou preset. */
export function isDefectAllowed(defect: Pick<DefectDefinition, 'affectsSecurity' | 'allowedEnvironments'>, environment: EnvironmentKind): boolean {
  if (environment === 'SHARED' && defect.affectsSecurity) {
    return false;
  }
  return defect.allowedEnvironments.includes(environment);
}

/** Workspace sem configuração: comportamento correto, sem defeitos (ADR 009). */
export function defaultWorkspaceConfig(workspaceId: string, catalog: DefectCatalog): WorkspaceEducationalConfig {
  return Object.freeze({
    workspaceId: parseWorkspaceId(workspaceId),
    revision: 0,
    catalogVersion: catalog.version,
    mode: 'STUDENT',
    preset: PRESET_NONE,
  });
}

function candidateDefectIds(config: WorkspaceEducationalConfig, catalog: DefectCatalog): readonly string[] {
  if (config.mode === 'CONTROLLED') {
    return config.enabledDefectIds;
  }
  switch (config.preset.kind) {
    case 'NONE':
      return [];
    case 'ALL':
      // Calculado sobre o catálogo vigente, limitado pela política do ambiente.
      return catalog.defects.map((defect) => defect.id);
    case 'LAB': {
      const { codeHash } = config.preset;
      return catalog.labPresets.find((lab) => lab.codeHash === codeHash)?.defectIds ?? [];
    }
  }
}

function permitted(ids: Iterable<string>, catalog: DefectCatalog, environment: EnvironmentKind): readonly string[] {
  const candidates = new Set(ids);
  return catalog.defects.filter((defect) => candidates.has(defect.id) && isDefectAllowed(defect, environment)).map((defect) => defect.id);
}

export function resolveEnabledDefects(
  config: WorkspaceEducationalConfig,
  catalog: DefectCatalog,
  environment: EnvironmentKind,
): readonly string[] {
  if (config.catalogVersion !== catalog.version) {
    return Object.freeze([]);
  }
  return Object.freeze(permitted(candidateDefectIds(config, catalog), catalog, environment));
}

function readPreset(preset: Preset): ResolvedPreset {
  return preset.kind === 'LAB' ? Object.freeze({ kind: 'LAB' }) : preset.kind === 'ALL' ? PRESET_ALL : PRESET_NONE;
}

/** Só o facilitador do próprio workspace, conferido antes de qualquer conteúdo. */
function assertFacilitatorOf(actor: Actor, workspaceId: string): void {
  if (actor.role !== 'FACILITATOR') {
    throw new EducationalAuthorizationError('FACILITATOR_REQUIRED');
  }
  if (actor.workspaceId !== workspaceId) {
    throw new EducationalAuthorizationError('WORKSPACE_MISMATCH');
  }
}

/** Leitura da configuração resolvida: somente o facilitador do próprio workspace. */
export function resolveForWorkspace(
  actor: Actor,
  config: WorkspaceEducationalConfig,
  catalog: DefectCatalog,
  environment: EnvironmentKind,
): ResolvedEducationalConfig {
  assertFacilitatorOf(actor, config.workspaceId);
  return resolve(config, catalog, environment);
}

/** Configuração resolvida para uso interno (casos de uso), já no escopo do workspace autorizado. */
export function resolve(config: WorkspaceEducationalConfig, catalog: DefectCatalog, environment: EnvironmentKind): ResolvedEducationalConfig {
  return Object.freeze({
    workspaceId: config.workspaceId,
    revision: config.revision,
    catalogVersion: config.catalogVersion,
    stale: config.catalogVersion !== catalog.version,
    mode: config.mode,
    preset: config.mode === 'STUDENT' ? readPreset(config.preset) : null,
    enabledDefectIds: resolveEnabledDefects(config, catalog, environment),
  });
}

/**
 * Alteração da configuração: somente o facilitador do próprio workspace. Rejeita defeitos não
 * permitidos no ambiente e combinações incompatíveis. Cria a revisão seguinte; a atual não muda.
 */
export function applyConfigChange(
  actor: Actor,
  current: WorkspaceEducationalConfig,
  rawChange: unknown,
  catalog: DefectCatalog,
  environment: EnvironmentKind,
): WorkspaceEducationalConfig {
  assertFacilitatorOf(actor, current.workspaceId);
  const change = parseConfigChange(rawChange, catalog);
  if (change.mode === 'CONTROLLED') {
    const blocked = change.enabledDefectIds.some((id) => {
      const defect = catalog.defects.find((candidate) => candidate.id === id);
      return defect === undefined || !isDefectAllowed(defect, environment);
    });
    if (blocked) {
      throw new InvalidEducationalConfigError('enabledDefectIds', 'contém defeito não permitido neste ambiente');
    }
    if (hasIncompatiblePair(change.enabledDefectIds, catalog)) {
      throw new InvalidEducationalConfigError('enabledDefectIds', 'contém defeitos incompatíveis entre si');
    }
  } else if (change.preset.kind === 'ALL' && hasIncompatiblePair(permitted(catalog.defects.map((d) => d.id), catalog, environment), catalog)) {
    throw new InvalidEducationalConfigError('preset', 'ALL reúne defeitos incompatíveis neste ambiente');
  }
  return Object.freeze({ workspaceId: current.workspaceId, revision: current.revision + 1, catalogVersion: catalog.version, ...change });
}

/**
 * O defeito está ativo nesta operação? Só se resolvido para o workspace, na versão vigente do
 * catálogo, e declarado para a operação. Operação desconhecida é erro.
 */
export function isDefectActive(resolved: ResolvedEducationalConfig, rawOperation: unknown, defectId: string, catalog: DefectCatalog): boolean {
  const operation = parseOperation(rawOperation, catalog);
  if (resolved.catalogVersion !== catalog.version || !resolved.enabledDefectIds.includes(defectId)) {
    return false;
  }
  return catalog.defects.some((defect) => defect.id === defectId && defect.operations.includes(operation));
}
