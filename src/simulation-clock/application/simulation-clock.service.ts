import type { WorkspaceAccess } from '../../identity/domain/workspace-access.js';
import { type BusinessDate, CLOCK_TIME_ZONE, parseBusinessDate } from '../domain/business-date.js';

/** Data vigente e a revisão que a produziu (0 = data de criação do workspace, nunca gravada). */
export interface ClockState {
  readonly date: BusinessDate;
  readonly revision: number;
}

/** Resultado da gravação: o vínculo pode ter acabado, o workspace ter sido arquivado ou outra revisão ter chegado antes. */
export type ClockPublishResult = 'PUBLISHED' | 'CONFLICT' | 'DENIED' | 'ARCHIVED';

/** Porta de persistência das revisões. */
export interface SimulationClockStore {
  /** Estado vigente, ou null se o workspace não existe. */
  current(workspaceId: string): Promise<ClockState | null>;
  /**
   * Grava a revisão `revision` numa transação, com auditoria, reconferindo o vínculo do ator e o estado do workspace.
   * CONFLICT se a revisão já existe.
   */
  publish(access: WorkspaceAccess, revision: number, date: BusinessDate, correlationId: string): Promise<ClockPublishResult>;
}

export interface ClockView extends ClockState {
  readonly workspaceId: string;
  readonly timeZone: typeof CLOCK_TIME_ZONE;
}

export class ClockConflictError extends Error {
  constructor() {
    super('O relógio mudou depois da revisão informada.');
    this.name = 'ClockConflictError';
  }
}

/** Acesso perdido entre a guarda e a gravação. */
export class ClockAccessLostError extends Error {
  constructor() {
    super('Acesso ao workspace encerrado.');
    this.name = 'ClockAccessLostError';
  }
}

export class ClockWorkspaceArchivedError extends Error {
  constructor() {
    super('Workspace arquivado não aceita alteração do relógio.');
    this.name = 'ClockWorkspaceArchivedError';
  }
}

/** Workspace inexistente pedido por um consumidor do servidor. */
export class ClockWorkspaceNotFoundError extends Error {
  constructor() {
    super('Workspace inexistente.');
    this.name = 'ClockWorkspaceNotFoundError';
  }
}

/** Relógio simulado por workspace: consulta e alteração pelo facilitador e leitura para consumidores do servidor. */
export class SimulationClockService {
  constructor(private readonly store: SimulationClockStore) {}

  /** Data de negócio vigente; consumidores registram a revisão usada. */
  async today(workspaceId: string): Promise<ClockState> {
    const state = await this.store.current(workspaceId);
    if (state === null) {
      throw new ClockWorkspaceNotFoundError();
    }
    return state;
  }

  async read(access: WorkspaceAccess): Promise<ClockView> {
    return view(access.workspaceId, await this.today(access.workspaceId));
  }

  /** `baseRevision` precisa ser a vigente. A mesma data vigente não grava nada. */
  async change(access: WorkspaceAccess, baseRevision: number, rawDate: string, correlationId: string): Promise<ClockView> {
    const current = await this.today(access.workspaceId);
    if (current.revision !== baseRevision) {
      throw new ClockConflictError();
    }
    const date = parseBusinessDate(rawDate);
    if (date === current.date) {
      return view(access.workspaceId, current);
    }
    const next: ClockState = { date, revision: current.revision + 1 };
    const result = await this.store.publish(access, next.revision, date, correlationId);
    if (result === 'CONFLICT') {
      throw new ClockConflictError();
    }
    if (result === 'DENIED') {
      throw new ClockAccessLostError();
    }
    if (result === 'ARCHIVED') {
      throw new ClockWorkspaceArchivedError();
    }
    return view(access.workspaceId, next);
  }
}

function view(workspaceId: string, state: ClockState): ClockView {
  return Object.freeze({ workspaceId, date: state.date, revision: state.revision, timeZone: CLOCK_TIME_ZONE });
}

/** Estrutura do pedido errada (400), distinta de data recusada pelas regras (422). */
export class InvalidClockRequestError extends Error {
  constructor() {
    super('O pedido deve ter exatamente baseRevision (inteiro não negativo) e date (texto).');
    this.name = 'InvalidClockRequestError';
  }
}

/** Corpo da alteração: exatamente `baseRevision` (inteiro ≥ 0) e `date` (texto). */
export function parseClockChange(raw: unknown): { baseRevision: number; date: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw) || Object.getPrototypeOf(raw) !== Object.prototype) {
    throw new InvalidClockRequestError();
  }
  const body = raw as Record<string, unknown>;
  const { baseRevision, date } = body;
  if (Object.keys(body).sort().join(',') !== 'baseRevision,date' || !Number.isSafeInteger(baseRevision) || (baseRevision as number) < 0 || typeof date !== 'string') {
    throw new InvalidClockRequestError();
  }
  return { baseRevision: baseRevision as number, date };
}
