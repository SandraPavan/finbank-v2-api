import { type DynamicModule, Module } from '@nestjs/common';
import type { EducationalCreditLimits } from '../config/app-config.js';
import { PrismaService } from '../persistence/prisma.service.js';
import { PrismaAccountStatementReader } from './adapters/prisma-account-statement.reader.js';
import { PrismaBankAccountStore } from './adapters/prisma-bank-account.store.js';
import { PrismaEducationalCreditStore } from './adapters/prisma-educational-credit.store.js';
import { AccountStatementService } from './application/account-statement.service.js';
import { BankAccountService } from './application/bank-account.service.js';
import { EducationalCreditService } from './application/educational-credit.service.js';
import { BankAccountController } from './http/bank-account.controller.js';
import { CustomerAccountController } from './http/customer-account.controller.js';

/** Conta do cliente: estado bancário e crédito educacional pelo facilitador; saldo e extrato para o cliente e o facilitador. */
@Module({})
export class BankAccountModule {
  static forRoot(options: { educationalCredit: EducationalCreditLimits }): DynamicModule {
    return {
      module: BankAccountModule,
      controllers: [BankAccountController, CustomerAccountController],
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
        {
          provide: AccountStatementService,
          useFactory: (prisma: PrismaService) => new AccountStatementService(new PrismaAccountStatementReader(prisma.client)),
          inject: [PrismaService],
        },
      ],
    };
  }
}
