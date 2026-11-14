import { Controller, Get } from '@nestjs/common';
import { HealthService, type LivenessStatus } from './health.service.js';

@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  getLiveness(): LivenessStatus {
    return this.healthService.getLiveness();
  }
}
