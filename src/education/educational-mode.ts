// Contrato dos modos educacionais (DEV-006). Domínio puro: sem NestJS, HTTP ou Prisma.
// Documentação: ../finbank-v2-educational/contracts/modos-educacionais.md
import type { DefectCatalog } from './defect-catalog.js';

export const EDUCATIONAL_MODES = ['STUDENT', 'CONTROLLED'] as const;
export type EducationalMode = (typeof EDUCATIONAL_MODES)[number];

/** Classificação do ambiente de implantação. Ausente = SHARED (mais restritivo). */
export const ENVIRONMENT_KINDS = ['ISOLATED', 'SHARED'] as const;
export type EnvironmentKind = (typeof ENVIRONMENT_KINDS)[number];

export const ACTOR_ROLES = ['STUDENT', 'FACILITATOR'] as const;
export type ActorRole = (typeof ACTOR_ROLES)[number];

export type Preset = { readonly kind: 'ALL' } | { readonly kind: 'LAB'; readonly labId: string };

export const PRESET_ALL: Preset = Object.freeze({ kind: 'ALL' });

/**
 * Quem age e em qual workspace. Deve vir da autorização validada (PD-03),
 * nunca de parâmetros enviados pelo cliente.
 */
export interface Actor {
  readonly role: ActorRole;
  readonly workspaceId: string;
}

export type WorkspaceEducationalConfig =
  | { readonly workspaceId: string; readonly mode: 'STUDENT'; readonly preset: Preset }
  | { readonly workspaceId: string; readonly mode: 'CONTROLLED'; readonly enabledDefectIds: readonly string[] };

/** Alteração pedida por um facilitador: a configuração sem o workspace (que vem do ator). */
export type EducationalConfigChange =
  | { readonly mode: 'STUDENT'; readonly preset: Preset }
  | { readonly mode: 'CONTROLLED'; readonly enabledDefectIds: readonly string[] };

/** Entrada rejeitada. A mensagem nunca inclui o valor recebido. */
export class InvalidEducationalConfigError extends Error {
  readonly field: string;

  constructor(field: string, expectation: string) {
    super(`Configuração educacional inválida: ${field} ${expectation}.`);
    this.name = 'InvalidEducationalConfigError';
    this.field = field;
  }
}

export type EducationalAuthorizationReason = 'FACILITATOR_REQUIRED' | 'WORKSPACE_MISMATCH';

export class EducationalAuthorizationError extends Error {
  readonly reason: EducationalAuthorizationReason;

  constructor(reason: EducationalAuthorizationReason) {
    super(
      reason === 'FACILITATOR_REQUIRED'
        ? 'Operação restrita ao facilitador do workspace.'
        : 'Configuração pertence a outro workspace.',
    );
    this.name = 'EducationalAuthorizationError';
    this.reason = reason;
  }
}

function isOneOf<T extends string>(values: readonly T[], raw: unknown): raw is T {
  return typeof raw === 'string' && (values as readonly string[]).includes(raw);
}

function isPlainObject(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw) && Object.getPrototypeOf(raw) === Object.prototype;
}

function assertOnlyKeys(raw: Record<string, unknown>, allowed: readonly string[], field: string): void {
  if (Object.keys(raw).some((key) => !allowed.includes(key))) {
    throw new InvalidEducationalConfigError(field, `aceita somente os campos ${allowed.join(', ')}`);
  }
}

export function parseMode(raw: unknown): EducationalMode {
  if (!isOneOf(EDUCATIONAL_MODES, raw)) {
    throw new InvalidEducationalConfigError('mode', `deve ser ${EDUCATIONAL_MODES.join(' ou ')}`);
  }
  return raw;
}

export function parseEnvironment(raw: unknown): EnvironmentKind {
  if (raw === undefined) {
    return 'SHARED';
  }
  if (!isOneOf(ENVIRONMENT_KINDS, raw)) {
    throw new InvalidEducationalConfigError('environment', `deve ser ${ENVIRONMENT_KINDS.join(' ou ')}`);
  }
  return raw;
}

export function parseWorkspaceId(raw: unknown): string {
  if (typeof raw !== 'string' || raw === '' || raw.trim() !== raw) {
    throw new InvalidEducationalConfigError('workspaceId', 'deve ser um identificador não vazio, sem espaços nas bordas');
  }
  return raw;
}

export function parsePreset(raw: unknown, catalog: DefectCatalog): Preset {
  if (!isPlainObject(raw)) {
    throw new InvalidEducationalConfigError('preset', 'deve ser um objeto { kind }');
  }
  if (raw['kind'] === 'ALL') {
    assertOnlyKeys(raw, ['kind'], 'preset');
    return PRESET_ALL;
  }
  if (raw['kind'] === 'LAB') {
    assertOnlyKeys(raw, ['kind', 'labId'], 'preset');
    const labId = raw['labId'];
    if (typeof labId !== 'string' || !catalog.labPresets.some((lab) => lab.labId === labId)) {
      throw new InvalidEducationalConfigError('preset.labId', 'deve identificar um preset de laboratório do catálogo');
    }
    return Object.freeze({ kind: 'LAB', labId });
  }
  throw new InvalidEducationalConfigError('preset.kind', 'deve ser ALL ou LAB');
}

function parseDefectIds(raw: unknown, catalog: DefectCatalog): readonly string[] {
  if (!Array.isArray(raw)) {
    throw new InvalidEducationalConfigError('enabledDefectIds', 'deve ser uma lista');
  }
  const ids: string[] = [];
  for (const id of raw as unknown[]) {
    if (typeof id !== 'string' || !catalog.defects.some((defect) => defect.id === id)) {
      throw new InvalidEducationalConfigError('enabledDefectIds', 'contém defeito inexistente no catálogo');
    }
    if (ids.includes(id)) {
      throw new InvalidEducationalConfigError('enabledDefectIds', 'contém defeito repetido');
    }
    ids.push(id);
  }
  return Object.freeze(ids);
}

/**
 * Valida uma alteração recebida de fora. Campos desconhecidos (inclusive `role` ou
 * `workspaceId`) são rejeitados: papel e workspace vêm somente do ator autorizado.
 */
export function parseConfigChange(raw: unknown, catalog: DefectCatalog): EducationalConfigChange {
  if (!isPlainObject(raw)) {
    throw new InvalidEducationalConfigError('alteração', 'deve ser um objeto');
  }
  const mode = parseMode(raw['mode']);
  if (mode === 'STUDENT') {
    assertOnlyKeys(raw, ['mode', 'preset'], 'alteração STUDENT');
    const preset = raw['preset'] === undefined ? PRESET_ALL : parsePreset(raw['preset'], catalog);
    return Object.freeze({ mode, preset });
  }
  assertOnlyKeys(raw, ['mode', 'enabledDefectIds'], 'alteração CONTROLLED');
  const enabledDefectIds =
    raw['enabledDefectIds'] === undefined ? Object.freeze([]) : parseDefectIds(raw['enabledDefectIds'], catalog);
  return Object.freeze({ mode, enabledDefectIds });
}
