import { Module } from '@nestjs/common';
import { PrismaService } from '../persistence/prisma.service.js';
import { PrismaEnrollmentStore } from './adapters/prisma-enrollment.store.js';
import { EnrollmentService } from './application/enrollment.service.js';
import { EnrollmentController } from './http/enrollment.controller.js';

/** Código de inscrição por workspace: geração e revogação pelo facilitador e verificação para o onboarding. */
@Module({
  controllers: [EnrollmentController],
  providers: [
    {
      provide: EnrollmentService,
      useFactory: (prisma: PrismaService) => new EnrollmentService(new PrismaEnrollmentStore(prisma.client)),
      inject: [PrismaService],
    },
  ],
  exports: [EnrollmentService],
})
export class EnrollmentModule {}
