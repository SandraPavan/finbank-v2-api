import { Module } from '@nestjs/common';
import { PrismaService } from '../persistence/prisma.service.js';
import { PrismaFacilitatorWorkspacesReader } from './adapters/prisma-facilitator-workspaces.reader.js';
import { PrismaWorkspaceAccessReader } from './adapters/prisma-workspace-access.reader.js';
import { FacilitatorWorkspacesService } from './application/facilitator-workspaces.service.js';
import { WorkspaceAccessService } from './application/workspace-access.service.js';

/** Identidades e vínculos com workspaces. Sem controller: as rotas ficam em `access/`. */
@Module({
  providers: [
    {
      provide: WorkspaceAccessService,
      useFactory: (prisma: PrismaService) => new WorkspaceAccessService(new PrismaWorkspaceAccessReader(prisma.client)),
      inject: [PrismaService],
    },
    {
      provide: FacilitatorWorkspacesService,
      useFactory: (prisma: PrismaService) => new FacilitatorWorkspacesService(new PrismaFacilitatorWorkspacesReader(prisma.client)),
      inject: [PrismaService],
    },
  ],
  exports: [FacilitatorWorkspacesService, WorkspaceAccessService],
})
export class IdentityModule {}
