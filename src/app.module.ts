import { type DynamicModule, Module } from '@nestjs/common';
import { AuthenticationModule } from './authentication/authentication.module.js';
import type { AppConfig } from './config/app-config.js';
import { HealthModule } from './health/health.module.js';
import { HttpModule } from './http/http.module.js';
import { IdentityModule } from './identity/identity.module.js';
import { PaymentExecutionModule } from './payment-execution/payment-execution.module.js';
import { PersistenceModule } from './persistence/persistence.module.js';
import { ReconciliationModule } from './reconciliation/reconciliation.module.js';

@Module({})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        AuthenticationModule.forRoot(config),
        HealthModule,
        HttpModule,
        IdentityModule,
        PaymentExecutionModule,
        ReconciliationModule,
        PersistenceModule.forRoot({ databaseUrl: config.databaseUrl }),
      ],
    };
  }
}
