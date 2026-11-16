import { Inject, Injectable, Logger } from '@nestjs/common';
import { DatabaseUnavailableError } from '../persistence/database-errors.js';
import { PrismaService } from '../persistence/prisma.service.js';

/** Limite técnico do probe de readiness (não é SLO). Abaixo do timeout do healthcheck do Compose. */
export const READINESS_TIMEOUT_MS = 2_000;

export interface LivenessStatus {
  readonly status: 'ok';
}

export type ReadinessStatus =
  | { readonly status: 'ok'; readonly checks: { readonly database: 'up' } }
  | { readonly status: 'unavailable'; readonly checks: { readonly database: 'down' } };

export type DatabaseProbe = Pick<PrismaService, 'ping'>;

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);
  private databaseUp: boolean | undefined;

  constructor(@Inject(PrismaService) private readonly database: DatabaseProbe) {}

  getLiveness(): LivenessStatus {
    return { status: 'ok' };
  }

  async getReadiness(): Promise<ReadinessStatus> {
    try {
      await this.database.ping(READINESS_TIMEOUT_MS);
      this.transition(true);
      return { status: 'ok', checks: { database: 'up' } };
    } catch (error) {
      // Somente a mensagem sanitizada vai para o log, e só na mudança de estado.
      const sanitized = error instanceof DatabaseUnavailableError ? error : new DatabaseUnavailableError(undefined);
      this.transition(false, sanitized.message);
      return { status: 'unavailable', checks: { database: 'down' } };
    }
  }

  private transition(up: boolean, reason?: string): void {
    if (this.databaseUp === up) {
      return;
    }
    const previous = this.databaseUp;
    this.databaseUp = up;
    if (!up) {
      this.logger.warn(`Readiness: ${reason ?? 'Banco de dados indisponível.'}`);
    } else if (previous === false) {
      this.logger.log('Readiness: banco de dados disponível novamente.');
    }
  }
}
