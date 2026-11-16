import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import { toDatabaseUnavailableError } from './database-errors.js';

export const DATABASE_OPTIONS = Symbol('DATABASE_OPTIONS');
export const DEFAULT_CONNECTION_TIMEOUT_MS = 5_000;

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

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }
}
