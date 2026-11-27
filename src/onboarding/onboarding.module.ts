import { type DynamicModule, Module } from '@nestjs/common';
import { Argon2PasswordHasher } from '../authentication/adapters/argon2-password-hasher.js';
import { PrismaAttemptStore } from '../authentication/adapters/prisma-attempt.store.js';
import { AttemptLimiter } from '../authentication/application/attempt-limiter.js';
import { AuthenticationError } from '../authentication/domain/errors.js';
import type { LoginLimits } from '../authentication/domain/login-limits.js';
import { EnrollmentService } from '../enrollment/application/enrollment.service.js';
import { EnrollmentModule } from '../enrollment/enrollment.module.js';
import { PrismaService } from '../persistence/prisma.service.js';
import { SimulationClockService } from '../simulation-clock/application/simulation-clock.service.js';
import { SimulationClockModule } from '../simulation-clock/simulation-clock.module.js';
import { PrismaOnboardingStore } from './adapters/prisma-onboarding.store.js';
import { OnboardingService } from './application/onboarding.service.js';
import { OnboardingController } from './http/onboarding.controller.js';

/** Solicitação de abertura: validações, inscrição, idade pela data simulada e gravação PENDING. */
@Module({})
export class OnboardingModule {
  /** `authentication` fornece o contexto de pré-autenticação; os limites são os do login. */
  static forRoot(authentication: DynamicModule, options: { loginLimits: LoginLimits }): DynamicModule {
    return {
      module: OnboardingModule,
      imports: [authentication, EnrollmentModule, SimulationClockModule],
      controllers: [OnboardingController],
      providers: [
        {
          provide: OnboardingService,
          useFactory: (prisma: PrismaService, enrollment: EnrollmentService, clock: SimulationClockService) =>
            new OnboardingService({
              store: new PrismaOnboardingStore(prisma.client),
              enrollment,
              clock,
              attempts: new AttemptLimiter(new PrismaAttemptStore(prisma.client), options.loginLimits),
              invalidAttempt: () => new AuthenticationError('INVALID_CREDENTIALS'),
              hasher: new Argon2PasswordHasher(),
            }),
          inject: [PrismaService, EnrollmentService, SimulationClockService],
        },
      ],
    };
  }
}
