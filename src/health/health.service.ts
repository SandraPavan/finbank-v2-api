import { Injectable } from '@nestjs/common';

export interface LivenessStatus {
  readonly status: 'ok';
}

@Injectable()
export class HealthService {
  getLiveness(): LivenessStatus {
    return { status: 'ok' };
  }
}
