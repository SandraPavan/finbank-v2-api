import { type DynamicModule, Module } from '@nestjs/common';
import { AccessModule } from './access/access.module.js';
import { AdministrationModule } from './administration/administration.module.js';
import { AuthenticationModule } from './authentication/authentication.module.js';
import { BankAccountModule } from './bank-account/bank-account.module.js';
import type { AppConfig } from './config/app-config.js';
import { EducationModule } from './education/education.module.js';
import { EnrollmentModule } from './enrollment/enrollment.module.js';
import { HealthModule } from './health/health.module.js';
import { HttpModule } from './http/http.module.js';
import { IdentityModule } from './identity/identity.module.js';
import { OnboardingModule } from './onboarding/onboarding.module.js';
import { PaymentExecutionModule } from './payment-execution/payment-execution.module.js';
import { PersistenceModule } from './persistence/persistence.module.js';
import { ReconciliationModule } from './reconciliation/reconciliation.module.js';
import { SimulationClockModule } from './simulation-clock/simulation-clock.module.js';

@Module({})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    const authentication = AuthenticationModule.forRoot(config);
    return {
      module: AppModule,
      imports: [
        AccessModule.forRoot(authentication),
        AdministrationModule.forRoot(config),
        EducationModule.forRoot(config),
        EnrollmentModule,
        authentication,
        BankAccountModule,
        HealthModule,
        HttpModule,
        IdentityModule,
        OnboardingModule.forRoot(authentication, config),
        PaymentExecutionModule,
        ReconciliationModule,
        SimulationClockModule,
        PersistenceModule.forRoot({ databaseUrl: config.databaseUrl }),
      ],
    };
  }
}
