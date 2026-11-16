import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { HealthService, type LivenessStatus, type ReadinessStatus } from './health.service.js';

/** Subconjunto da resposta HTTP usado aqui, sem acoplar o controller ao Express. */
interface ProbeResponse {
  status(code: number): unknown;
  setHeader(name: string, value: string): unknown;
}

@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  /** Processo vivo; não consulta dependências. */
  @Get('live')
  getLiveness(@Res({ passthrough: true }) response: ProbeResponse): LivenessStatus {
    response.setHeader('Cache-Control', 'no-store');
    return this.healthService.getLiveness();
  }

  /** Pronto para atender: reflete a disponibilidade atual do PostgreSQL (200 ou 503). */
  @Get('ready')
  async getReadiness(@Res({ passthrough: true }) response: ProbeResponse): Promise<ReadinessStatus> {
    response.setHeader('Cache-Control', 'no-store');
    const readiness = await this.healthService.getReadiness();
    response.status(readiness.status === 'ok' ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return readiness;
  }
}
