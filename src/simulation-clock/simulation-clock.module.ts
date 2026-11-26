import { Module } from '@nestjs/common';
import { PrismaService } from '../persistence/prisma.service.js';
import { PrismaSimulationClockStore } from './adapters/prisma-simulation-clock.store.js';
import { SimulationClockService } from './application/simulation-clock.service.js';
import { SimulationClockController } from './http/simulation-clock.controller.js';

/** Relógio simulado por workspace: revisões gravadas, administração pelo facilitador e leitura por outros módulos. */
@Module({
  controllers: [SimulationClockController],
  providers: [
    {
      provide: SimulationClockService,
      useFactory: (prisma: PrismaService) => new SimulationClockService(new PrismaSimulationClockStore(prisma.client)),
      inject: [PrismaService],
    },
  ],
  exports: [SimulationClockService],
})
export class SimulationClockModule {}
