import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import { DatabaseUnavailableError, toDatabaseUnavailableError } from './database-errors.js';

export const DATABASE_OPTIONS = Symbol('DATABASE_OPTIONS');
export const DEFAULT_CONNECTION_TIMEOUT_MS = 5_000;
export const PING_TIMEOUT_CODE = 'PingTimeout';

export interface DatabaseOptions {
  readonly databaseUrl: string;
  readonly connectionTimeoutMs?: number;
}

/**
 * Adaptador de persistência: dono do ciclo de vida da conexão PostgreSQL.
 * Conecta e valida na inicialização (fail-fast) e desconecta no encerramento.
 */
@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  readonly client: PrismaClient;

  constructor(@Inject(DATABASE_OPTIONS) options: DatabaseOptions) {
    const adapter = new PrismaPg({
      connectionString: options.databaseUrl,
      connectionTimeoutMillis: options.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS,
    });
    this.client = new PrismaClient({ adapter });
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.client.$connect();
      await this.client.$queryRaw`SELECT 1`;
    } catch (error) {
      await this.client.$disconnect().catch(() => undefined);
      throw toDatabaseUnavailableError(error);
    }
  }

  /**
   * Verifica a disponibilidade atual do banco com `SELECT 1`, limitada a `timeoutMs`.
   * Falhas e estouro do limite viram `DatabaseUnavailableError` sanitizado.
   */
  async ping(timeoutMs: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new DatabaseUnavailableError(PING_TIMEOUT_CODE)), timeoutMs);
    });
    try {
      await Promise.race([this.client.$queryRaw`SELECT 1`, timeout]);
    } catch (error) {
      throw error instanceof DatabaseUnavailableError ? error : toDatabaseUnavailableError(error);
    } finally {
      clearTimeout(timer);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }
}
