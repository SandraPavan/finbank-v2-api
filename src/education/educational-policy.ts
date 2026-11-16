// Política de segurança, resolução e alteração da configuração educacional por workspace (DEV-006).
import type { DefectCatalog, DefectDefinition } from './defect-catalog.js';
import {
  type Actor,
  EducationalAuthorizationError,
  type EducationalMode,
  type EnvironmentKind,
  InvalidEducationalConfigError,
  parseConfigChange,
  PRESET_ALL,
  type Preset,
  parseWorkspaceId,
  type WorkspaceEducationalConfig,
} from './educational-mode.js';

export interface ResolvedEducationalConfig {
  readonly workspaceId: string;
  readonly mode: EducationalMode;
  readonly preset: Preset | null;
  /** Defeitos efetivamente executáveis. Com o catálogo atual, sempre vazio. */
  readonly enabledDefectIds: readonly string[];
}

/** Segurança em ambiente compartilhado prevalece sobre qualquer modo ou preset. */
export function isDefectAllowed(defect: DefectDefinition, environment: EnvironmentKind): boolean {
  if (environment === 'SHARED' && defect.affectsSecurity) {
    return false;
  }
  return defect.allowedEnvironments.includes(environment);
}

/** Default de workspace sem configuração: STUDENT com preset ALL (ADR 006). */
export function defaultWorkspaceConfig(workspaceId: string): WorkspaceEducationalConfig {
  return Object.freeze({ workspaceId: parseWorkspaceId(workspaceId), mode: 'STUDENT', preset: PRESET_ALL });
}

function candidateDefectIds(config: WorkspaceEducationalConfig, catalog: DefectCatalog): readonly string[] {
  if (config.mode === 'CONTROLLED') {
    return config.enabledDefectIds;
  }
  if (config.preset.kind === 'ALL') {
    // ALL é calculado sobre o catálogo vigente: defeitos futuros permitidos entram automaticamente.
    return catalog.defects.map((defect) => defect.id);
  }
  const { labId } = config.preset;
  return catalog.labPresets.find((lab) => lab.labId === labId)?.defectIds ?? [];
}

export function resolveEnabledDefects(
  config: WorkspaceEducationalConfig,
  catalog: DefectCatalog,
  environment: EnvironmentKind,
): readonly string[] {
  const candidates = new Set(candidateDefectIds(config, catalog));
  return Object.freeze(
    catalog.defects
      .filter((defect) => candidates.has(defect.id) && isDefectAllowed(defect, environment))
      .map((defect) => defect.id),
  );
}

function assertSameWorkspace(actor: Actor, config: WorkspaceEducationalConfig): void {
  if (actor.workspaceId !== config.workspaceId) {
    throw new EducationalAuthorizationError('WORKSPACE_MISMATCH');
  }
}

/** Leitura da configuração resolvida: qualquer papel, somente do próprio workspace. */
export function resolveForWorkspace(
  actor: Actor,
  config: WorkspaceEducationalConfig,
  catalog: DefectCatalog,
  environment: EnvironmentKind,
): ResolvedEducationalConfig {
  assertSameWorkspace(actor, config);
  return Object.freeze({
    workspaceId: config.workspaceId,
    mode: config.mode,
    preset: config.mode === 'STUDENT' ? config.preset : null,
    enabledDefectIds: resolveEnabledDefects(config, catalog, environment),
  });
}

/**
 * Alteração da configuração: somente o facilitador do próprio workspace. Autorização é
 * verificada antes de interpretar o conteúdo; defeitos não permitidos no ambiente são rejeitados.
 * Retorna nova configuração; a atual não é modificada.
 */
export function applyConfigChange(
  actor: Actor,
  current: WorkspaceEducationalConfig,
  rawChange: unknown,
  catalog: DefectCatalog,
  environment: EnvironmentKind,
): WorkspaceEducationalConfig {
  if (actor.role !== 'FACILITATOR') {
    throw new EducationalAuthorizationError('FACILITATOR_REQUIRED');
  }
  assertSameWorkspace(actor, current);
  const change = parseConfigChange(rawChange, catalog);
  if (change.mode === 'CONTROLLED') {
    const blocked = change.enabledDefectIds.some((id) => {
      const defect = catalog.defects.find((candidate) => candidate.id === id);
      return defect === undefined || !isDefectAllowed(defect, environment);
    });
    if (blocked) {
      throw new InvalidEducationalConfigError('enabledDefectIds', 'contém defeito não permitido neste ambiente');
    }
  }
  return Object.freeze({ workspaceId: current.workspaceId, ...change });
}
