import { Module } from '@nestjs/common';
import { PrismaService } from '../persistence/prisma.service.js';
import { PrismaWorkspaceAccessReader } from './adapters/prisma-workspace-access.reader.js';
import { WorkspaceAccessService } from './application/workspace-access.service.js';

/** Identidades e vínculos com workspaces. Sem controller: nenhuma rota é exposta nesta etapa. */
@Module({
  providers: [
    {
      provide: WorkspaceAccessService,
      useFactory: (prisma: PrismaService) => new WorkspaceAccessService(new PrismaWorkspaceAccessReader(prisma.client)),
      inject: [PrismaService],
    },
  ],
  exports: [WorkspaceAccessService],
})
export class IdentityModule {}
