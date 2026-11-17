// Contrato dos modos educacionais. Domínio puro: sem NestJS, HTTP ou Prisma.
// Identificadores de defeito são opacos; presets de laboratório são indexados pelo
// SHA-256 do código do laboratório. Mensagens de erro nunca exibem valores recebidos,
// códigos ou hashes.
import { createHash } from 'node:crypto';
import type { DefectCatalog } from './defect-catalog.js';

export const EDUCATIONAL_MODES = ['STUDENT', 'CONTROLLED'] as const;
export type EducationalMode = (typeof EDUCATIONAL_MODES)[number];

/** Classificação do ambiente de implantação. Ausente = SHARED (mais restritivo). */
export const ENVIRONMENT_KINDS = ['ISOLATED', 'SHARED'] as const;
export type EnvironmentKind = (typeof ENVIRONMENT_KINDS)[number];

export const ACTOR_ROLES = ['STUDENT', 'FACILITATOR'] as const;
export type ActorRole = (typeof ACTOR_ROLES)[number];

/** Código de laboratório: A-Z, 0-9 e hífen, 8 a 32 caracteres, comparação exata. */
export const LAB_CODE_PATTERN = /^[A-Z0-9-]{8,32}$/;
/** SHA-256 em hexadecimal minúsculo. */
export const CODE_HASH_PATTERN = /^[0-9a-f]{64}$/;

export type Preset = { readonly kind: 'ALL' } | { readonly kind: 'LAB'; readonly codeHash: string };

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

/** SHA-256 (hex minúsculo) do código. Representação no catálogo; não é autorização. */
export function hashLabCode(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

/** Valida o formato do código de laboratório e devolve seu hash. Nunca ecoa o código. */
export function parseLabCode(raw: unknown): string {
  if (typeof raw !== 'string' || !LAB_CODE_PATTERN.test(raw)) {
    throw new InvalidEducationalConfigError('código de laboratório', 'deve ter de 8 a 32 caracteres A-Z, 0-9 ou hífen');
  }
  return hashLabCode(raw);
}

/** Resolve o código para o preset do catálogo. Código desconhecido é rejeitado sem detalhes. */
export function resolveLabPreset(raw: unknown, catalog: DefectCatalog): Preset {
  const codeHash = parseLabCode(raw);
  if (!catalog.labPresets.some((lab) => lab.codeHash === codeHash)) {
    throw new InvalidEducationalConfigError('código de laboratório', 'não corresponde a um preset do catálogo');
  }
  return Object.freeze({ kind: 'LAB', codeHash });
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
    assertOnlyKeys(raw, ['kind', 'code'], 'preset');
    return resolveLabPreset(raw['code'], catalog);
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
