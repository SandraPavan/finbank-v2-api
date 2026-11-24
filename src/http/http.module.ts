import { Controller, Get, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { PublicAccess } from './access-policy.js';
import { OPENAPI_DOCUMENT } from './openapi.js';
import { ProblemFilter } from './problem.filter.js';

@Controller('api/v1')
@PublicAccess()
export class OpenApiController {
  @Get('openapi.json')
  document(): typeof OPENAPI_DOCUMENT {
    return OPENAPI_DOCUMENT;
  }
}

@Module({
  controllers: [OpenApiController],
  providers: [{ provide: APP_FILTER, useClass: ProblemFilter }],
})
export class HttpModule {}
