import { type DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { IdentityModule } from '../identity/identity.module.js';
import { AccessGuard } from './http/access.guard.js';
import { FacilitatorWorkspacesController } from './http/facilitator-workspaces.controller.js';

/** Autorização por operação em todas as rotas e consultas do facilitador. */
@Module({})
export class AccessModule {
  /** Recebe a mesma instância do módulo de autenticação composta na raiz. */
  static forRoot(authentication: DynamicModule): DynamicModule {
    return {
      module: AccessModule,
      imports: [authentication, IdentityModule],
      controllers: [FacilitatorWorkspacesController],
      providers: [{ provide: APP_GUARD, useClass: AccessGuard }],
    };
  }
}
