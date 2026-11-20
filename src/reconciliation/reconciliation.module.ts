import { Module } from '@nestjs/common';
import { PrismaService } from '../persistence/prisma.service.js';
import { PrismaReconciliationReader } from './adapters/prisma-reconciliation.reader.js';
import { ReconciliationService } from './application/reconciliation.service.js';

/**
 * Reconciliação somente leitura. Sem controller: nenhuma rota é exposta nesta etapa.
 * Não depende do PaymentExecution; lê o ledger e os saldos diretamente.
 */
@Module({
  providers: [
    {
      provide: ReconciliationService,
      useFactory: (prisma: PrismaService) => new ReconciliationService(new PrismaReconciliationReader(prisma.client)),
      inject: [PrismaService],
    },
  ],
  exports: [ReconciliationService],
})
export class ReconciliationModule {}
