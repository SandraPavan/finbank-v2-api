import { type DynamicModule, Module } from '@nestjs/common';
import type { EducationalCreditLimits } from '../config/app-config.js';
import { PrismaService } from '../persistence/prisma.service.js';
import { PrismaBankAccountStore } from './adapters/prisma-bank-account.store.js';
import { PrismaEducationalCreditStore } from './adapters/prisma-educational-credit.store.js';
import { BankAccountService } from './application/bank-account.service.js';
import { EducationalCreditService } from './application/educational-credit.service.js';
import { BankAccountController } from './http/bank-account.controller.js';

/** Conta do cliente: estado bancário (bloqueio e desbloqueio) e crédito educacional pelo facilitador. */
@Module({})
export class BankAccountModule {
  static forRoot(options: { educationalCredit: EducationalCreditLimits }): DynamicModule {
    return {
      module: BankAccountModule,
      controllers: [BankAccountController],
      providers: [
        {
          provide: BankAccountService,
          useFactory: (prisma: PrismaService) => new BankAccountService(new PrismaBankAccountStore(prisma.client)),
          inject: [PrismaService],
        },
        {
          provide: EducationalCreditService,
          useFactory: (prisma: PrismaService) => new EducationalCreditService(new PrismaEducationalCreditStore(prisma.client), options.educationalCredit),
          inject: [PrismaService],
        },
      ],
    };
  }
}
