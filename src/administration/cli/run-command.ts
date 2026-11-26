import type { OperatorService, PasswordSource } from '../application/operator.service.js';
import type { Command } from './arguments.js';

const changedOr = (changed: boolean, text: string): string => (changed ? text : 'sem mudança: já estava assim');

/** Executa o comando e devolve a mensagem de sucesso, sem dados pessoais. Só a emissão mostra a credencial, uma vez. */
export async function runCommand(service: OperatorService, command: Command, password: PasswordSource): Promise<string> {
  const { alias, email, modality } = command;
  switch (command.name) {
    case 'bootstrap': {
      const done = await service.bootstrap(alias, email, password);
      const state = (created: boolean): string => (created ? 'criado' : 'já existia');
      return `workspace: ${state(done.workspaceCreated)}; facilitador: ${state(done.facilitatorCreated)}; vínculo: ${state(done.membershipCreated)}`;
    }
    case 'workspace create':
      await service.createWorkspace(alias, modality);
      return `workspace criado (${modality})`;
    case 'facilitator create':
      await service.createFacilitator(email, password);
      return 'facilitador criado';
    case 'customer create':
      await service.createCustomer(alias, email, password);
      return 'cliente criado';
    case 'facilitator disable':
      return changedOr(await service.setFacilitatorState(email, 'DISABLED'), 'facilitador desativado e sessões encerradas');
    case 'facilitator enable':
      return changedOr(await service.setFacilitatorState(email, 'ACTIVE'), 'facilitador reativado');
    case 'facilitator reset': {
      const issued = await service.resetFacilitator(email);
      return `credencial temporária (mostrada só agora): ${issued.temporaryCredential}\nválida até ${issued.expiresAt.toISOString()}; a senha e as sessões anteriores deixaram de valer`;
    }
    case 'membership grant':
      return changedOr(await service.setMembership(alias, email, 'ACTIVE'), 'vínculo ativo');
    case 'membership revoke':
      return changedOr(await service.setMembership(alias, email, 'REVOKED'), 'vínculo revogado');
  }
}
