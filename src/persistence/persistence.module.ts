import { type DynamicModule, Module } from '@nestjs/common';
import { DATABASE_OPTIONS, type DatabaseOptions, PrismaService } from './prisma.service.js';

@Module({})
export class PersistenceModule {
  static forRoot(options: DatabaseOptions): DynamicModule {
    return {
      module: PersistenceModule,
      providers: [{ provide: DATABASE_OPTIONS, useValue: options }, PrismaService],
      exports: [PrismaService],
    };
  }
}
