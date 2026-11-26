import { type DynamicModule, Module } from '@nestjs/common';
import { PrismaService } from '../persistence/prisma.service.js';
import { PrismaEducationalConfigStore } from './adapters/prisma-educational-config.store.js';
import { EducationalConfigService } from './application/educational-config.service.js';
import { DEFECT_CATALOG, type DefectCatalog } from './defect-catalog.js';
import type { EnvironmentKind } from './educational-mode.js';
import { EducationalConfigController } from './http/educational-config.controller.js';

/** Catálogo em uso; testes trocam por um catálogo fictício. */
export const EDUCATIONAL_CATALOG = Symbol('EDUCATIONAL_CATALOG');

/** Configuração educacional por workspace: revisões gravadas e administração pelo facilitador. */
@Module({})
export class EducationModule {
  static forRoot({ environment }: { environment: EnvironmentKind }): DynamicModule {
    return {
      module: EducationModule,
      controllers: [EducationalConfigController],
      providers: [
        { provide: EDUCATIONAL_CATALOG, useValue: DEFECT_CATALOG },
        {
          provide: EducationalConfigService,
          useFactory: (prisma: PrismaService, catalog: DefectCatalog) =>
            new EducationalConfigService({ store: new PrismaEducationalConfigStore(prisma.client), catalog, environment }),
          inject: [PrismaService, EDUCATIONAL_CATALOG],
        },
      ],
    };
  }
}
