import { type DynamicModule, Module } from '@nestjs/common';
import type { AppConfig } from './config/app-config.js';
import { HealthModule } from './health/health.module.js';
import { PaymentExecutionModule } from './payment-execution/payment-execution.module.js';
import { PersistenceModule } from './persistence/persistence.module.js';

@Module({})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        HealthModule,
        PaymentExecutionModule,
        PersistenceModule.forRoot({ databaseUrl: config.databaseUrl }),
      ],
    };
  }
}
