import { type DynamicModule, Module } from '@nestjs/common';
import type { AppConfig } from './config/app-config.js';
import { HealthModule } from './health/health.module.js';
import { PersistenceModule } from './persistence/persistence.module.js';

@Module({})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [HealthModule, PersistenceModule.forRoot({ databaseUrl: config.databaseUrl })],
    };
  }
}
