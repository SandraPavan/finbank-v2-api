import { Module } from '@nestjs/common';
import { PrismaService } from '../persistence/prisma.service.js';
import { PrismaBankAccountStore } from './adapters/prisma-bank-account.store.js';
import { BankAccountService } from './application/bank-account.service.js';
import { BankAccountController } from './http/bank-account.controller.js';

/** Estado bancário da conta do cliente: bloqueio e desbloqueio pelo facilitador, com histórico e auditoria. */
@Module({
  controllers: [BankAccountController],
  providers: [
    {
      provide: BankAccountService,
      useFactory: (prisma: PrismaService) => new BankAccountService(new PrismaBankAccountStore(prisma.client)),
      inject: [PrismaService],
    },
  ],
})
export class BankAccountModule {}
