import { type DynamicModule, Module } from '@nestjs/common';
import { PrismaService } from '../persistence/prisma.service.js';
import { Argon2PasswordHasher } from './adapters/argon2-password-hasher.js';
import { PrismaAuthenticationStore } from './adapters/prisma-authentication.store.js';
import { RandomSessionSecrets } from './adapters/random-session-secrets.js';
import { AuthenticationService } from './application/authentication.service.js';
import type { SessionSettings } from './domain/session.js';

/** Senha e sessões. Sem controller: nenhuma rota é exposta nesta etapa. */
@Module({})
export class AuthenticationModule {
  static forRoot(settings: SessionSettings): DynamicModule {
    return {
      module: AuthenticationModule,
      providers: [
        {
          provide: AuthenticationService,
          useFactory: async (prisma: PrismaService) => {
            const hasher = new Argon2PasswordHasher();
            const secrets = new RandomSessionSecrets();
            return new AuthenticationService({
              store: new PrismaAuthenticationStore(prisma.client),
              hasher,
              secrets,
              settings,
              decoyHash: await hasher.hash(secrets.generate()),
            });
          },
          inject: [PrismaService],
        },
      ],
      exports: [AuthenticationService],
    };
  }
}
