import { Module } from '@nestjs/common';
import { PrismaService } from '../persistence/prisma.service.js';
import { PrismaCustomerAdministrationStore } from './adapters/prisma-customer-administration.store.js';
import { CustomerAdministrationService } from './application/customer-administration.service.js';
import { FacilitatorCustomersController } from './http/facilitator-customers.controller.js';

/** Administração por HTTP. As operações do operador ficam fora da aplicação servida (`admin.ts`). */
@Module({
  controllers: [FacilitatorCustomersController],
  providers: [
    {
      provide: CustomerAdministrationService,
      useFactory: (prisma: PrismaService) => new CustomerAdministrationService(new PrismaCustomerAdministrationStore(prisma.client)),
      inject: [PrismaService],
    },
  ],
})
export class AdministrationModule {}
