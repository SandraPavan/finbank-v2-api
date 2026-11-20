import { Module } from '@nestjs/common';
import { PrismaService } from '../persistence/prisma.service.js';
import { PrismaPaymentExecutionStore } from './adapters/prisma-payment-execution.store.js';
import { PaymentExecutionService } from './application/payment-execution.service.js';

/**
 * Fronteira única de escrita de saldos. Sem controller: nenhuma rota é exposta nesta etapa.
 * A aplicação e o domínio não dependem de NestJS; a composição acontece aqui.
 */
@Module({
  providers: [
    {
      provide: PaymentExecutionService,
      useFactory: (prisma: PrismaService) => new PaymentExecutionService(new PrismaPaymentExecutionStore(prisma.client)),
      inject: [PrismaService],
    },
  ],
  exports: [PaymentExecutionService],
})
export class PaymentExecutionModule {}
