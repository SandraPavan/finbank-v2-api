import { type DynamicModule, Module } from '@nestjs/common';
import { Argon2PasswordHasher } from '../authentication/adapters/argon2-password-hasher.js';
import { PrismaService } from '../persistence/prisma.service.js';
import { PrismaCustomerAdministrationStore } from './adapters/prisma-customer-administration.store.js';
import { RandomTemporaryCredential } from './adapters/random-temporary-credential.js';
import { CustomerAdministrationService } from './application/customer-administration.service.js';
import { FacilitatorCustomersController } from './http/facilitator-customers.controller.js';

export interface AdministrationOptions {
  readonly temporaryCredentialHours: number;
}

/** Administração por HTTP. As operações do operador ficam fora da aplicação servida (`admin.ts`). */
@Module({})
export class AdministrationModule {
  static forRoot({ temporaryCredentialHours }: AdministrationOptions): DynamicModule {
    return {
      module: AdministrationModule,
      controllers: [FacilitatorCustomersController],
      providers: [
        {
          provide: CustomerAdministrationService,
          useFactory: (prisma: PrismaService) =>
            new CustomerAdministrationService({
              store: new PrismaCustomerAdministrationStore(prisma.client),
              hasher: new Argon2PasswordHasher(),
              generator: new RandomTemporaryCredential(),
              temporaryCredentialHours,
            }),
          inject: [PrismaService],
        },
      ],
    };
  }
}
