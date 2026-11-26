import type { WorkspaceAccess } from '../../identity/domain/workspace-access.js';
import type { DefectCatalog } from '../defect-catalog.js';
import { type EnvironmentKind, InvalidEducationalConfigError, type WorkspaceEducationalConfig } from '../educational-mode.js';
import { applyConfigChange, defaultWorkspaceConfig, isDefectAllowed, type ResolvedEducationalConfig, resolveForWorkspace } from '../educational-policy.js';

/** Resultado da gravação: o vínculo pode ter acabado ou outra revisão ter chegado antes. */
export type PublishResult = 'PUBLISHED' | 'CONFLICT' | 'DENIED';

/** Porta de persistência das revisões. */
export interface EducationalConfigStore {
  /** Revisão vigente, ou null se o workspace nunca foi configurado. */
  current(workspaceId: string): Promise<WorkspaceEducationalConfig | null>;
  /**
   * Grava a revisão seguinte numa transação, com auditoria, reconferindo o vínculo do ator.
   * CONFLICT se a revisão já existe.
   */
  publish(access: WorkspaceAccess, next: WorkspaceEducationalConfig, correlationId: string): Promise<PublishResult>;
}

export interface EducationalView extends ResolvedEducationalConfig {
  readonly environment: EnvironmentKind;
  /** Defeitos do catálogo vigente que a política deste ambiente permite escolher. */
  readonly availableDefectIds: readonly string[];
}

export class ConfigurationConflictError extends Error {
  constructor() {
    super('A configuração mudou depois da revisão informada.');
    this.name = 'ConfigurationConflictError';
  }
}

/** Acesso perdido entre a guarda e a gravação. */
export class ConfigurationAccessLostError extends Error {
  constructor() {
    super('Acesso ao workspace encerrado.');
    this.name = 'ConfigurationAccessLostError';
  }
}

export interface EducationalConfigDependencies {
  readonly store: EducationalConfigStore;
  readonly catalog: DefectCatalog;
  readonly environment: EnvironmentKind;
}

/** Consulta e alteração da configuração educacional pelo facilitador do workspace. */
export class EducationalConfigService {
  constructor(private readonly deps: EducationalConfigDependencies) {}

  async read(access: WorkspaceAccess): Promise<EducationalView> {
    return this.view(access, await this.current(access.workspaceId));
  }

  /** `baseRevision` precisa ser a vigente: quem altera viu o estado que está mudando. */
  async change(access: WorkspaceAccess, baseRevision: number, configuration: unknown, correlationId: string): Promise<EducationalView> {
    const { catalog, environment, store } = this.deps;
    const current = await this.current(access.workspaceId);
    if (current.revision !== baseRevision) {
      throw new ConfigurationConflictError();
    }
    const next = applyConfigChange(access, current, configuration, catalog, environment);
    const result = await store.publish(access, next, correlationId);
    if (result === 'CONFLICT') {
      throw new ConfigurationConflictError();
    }
    if (result === 'DENIED') {
      throw new ConfigurationAccessLostError();
    }
    return this.view(access, next);
  }

  private async current(workspaceId: string): Promise<WorkspaceEducationalConfig> {
    return (await this.deps.store.current(workspaceId)) ?? defaultWorkspaceConfig(workspaceId, this.deps.catalog);
  }

  private view(access: WorkspaceAccess, config: WorkspaceEducationalConfig): EducationalView {
    const { catalog, environment } = this.deps;
    return Object.freeze({
      ...resolveForWorkspace(access, config, catalog, environment),
      environment,
      availableDefectIds: Object.freeze(catalog.defects.filter((d) => isDefectAllowed(d, environment)).map((d) => d.id)),
    });
  }
}

/** Corpo da alteração: exatamente `baseRevision` (inteiro ≥ 0) e `configuration`. */
export function parseChangeRequest(raw: unknown): { baseRevision: number; configuration: unknown } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw) || Object.getPrototypeOf(raw) !== Object.prototype) {
    throw new InvalidRequestError();
  }
  const body = raw as Record<string, unknown>;
  const keys = Object.keys(body).sort();
  const { baseRevision, configuration } = body;
  if (keys.join(',') !== 'baseRevision,configuration' || !Number.isSafeInteger(baseRevision) || (baseRevision as number) < 0) {
    throw new InvalidRequestError();
  }
  return { baseRevision: baseRevision as number, configuration };
}

/** Estrutura do pedido errada (400), distinta de configuração recusada pelas regras (422). */
export class InvalidRequestError extends InvalidEducationalConfigError {
  constructor() {
    super('pedido', 'deve ter exatamente baseRevision (inteiro não negativo) e configuration');
    this.name = 'InvalidRequestError';
  }
}
