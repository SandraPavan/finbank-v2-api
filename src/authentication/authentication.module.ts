import { type DynamicModule, Module } from '@nestjs/common';
import type { CookieTransport } from '../config/app-config.js';
import { PrismaService } from '../persistence/prisma.service.js';
import { Argon2PasswordHasher } from './adapters/argon2-password-hasher.js';
import { PrismaAttemptStore } from './adapters/prisma-attempt.store.js';
import { PrismaAuthenticationStore } from './adapters/prisma-authentication.store.js';
import { RandomSessionSecrets } from './adapters/random-session-secrets.js';
import { AttemptLimiter } from './application/attempt-limiter.js';
import { AuthenticationService } from './application/authentication.service.js';
import { LimitedAuthenticationService } from './application/limited-authentication.service.js';
import type { LoginLimits } from './domain/login-limits.js';
import type { SessionSettings } from './domain/session.js';
import { AuthContext } from './http/auth-context.js';
import { AuthenticationController } from './http/authentication.controller.js';

export interface AuthenticationOptions {
  readonly session: SessionSettings;
  readonly loginLimits: LoginLimits;
  readonly cookieTransport: CookieTransport;
}

/** Senha, sessões e autenticação por HTTP. Login e troca de senha só são expostos com limite de tentativas. */
@Module({})
export class AuthenticationModule {
  static forRoot(options: AuthenticationOptions): DynamicModule {
    return {
      module: AuthenticationModule,
      controllers: [AuthenticationController],
      providers: [
        RandomSessionSecrets,
        {
          provide: AuthenticationService,
          useFactory: async (prisma: PrismaService, secrets: RandomSessionSecrets) => {
            const hasher = new Argon2PasswordHasher();
            return new AuthenticationService({
              store: new PrismaAuthenticationStore(prisma.client),
              hasher,
              secrets,
              settings: options.session,
              decoyHash: await hasher.hash(secrets.generate()),
            });
          },
          inject: [PrismaService, RandomSessionSecrets],
        },
        {
          provide: LimitedAuthenticationService,
          useFactory: (auth: AuthenticationService, prisma: PrismaService) =>
            new LimitedAuthenticationService(auth, new AttemptLimiter(new PrismaAttemptStore(prisma.client), options.loginLimits)),
          inject: [AuthenticationService, PrismaService],
        },
        {
          provide: AuthContext,
          useFactory: (auth: AuthenticationService) => new AuthContext(auth, options.cookieTransport),
          inject: [AuthenticationService],
        },
      ],
      exports: [AuthenticationService, AuthContext],
    };
  }
}
