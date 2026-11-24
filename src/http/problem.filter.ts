import { type ArgumentsHost, Catch, HttpException, Logger } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { type HttpRequest, type HttpResponse, isApiPath } from './http-types.js';
import { correlationIdOf, type ProblemCode, ProblemError, sendProblem } from './problem.js';

const BY_STATUS: Readonly<Record<number, ProblemCode>> = {
  400: 'VALIDATION_ERROR',
  403: 'ACCESS_DENIED',
  404: 'RESOURCE_NOT_FOUND',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  503: 'TEMPORARY_UNAVAILABLE',
};

function statusOf(error: unknown): number | undefined {
  if (error instanceof HttpException) {
    return error.getStatus();
  }
  // Erros do leitor de corpo (http-errors), ocorridos antes das rotas.
  const status = typeof error === 'object' && error !== null ? (error as { status?: unknown }).status : undefined;
  return typeof status === 'number' ? status : undefined;
}

/** Erros de `/api/v1` viram Problem Details; as demais rotas mantêm o tratamento padrão. */
@Catch()
export class ProblemFilter extends BaseExceptionFilter {
  private readonly log = new Logger(ProblemFilter.name);

  override catch(error: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<HttpRequest>();
    if (!isApiPath(request.originalUrl)) {
      super.catch(error, host);
      return;
    }
    sendProblem(request, http.getResponse<HttpResponse>(), this.toProblem(error, request));
  }

  private toProblem(error: unknown, request: HttpRequest): ProblemError {
    if (error instanceof ProblemError) {
      return error;
    }
    const code = BY_STATUS[statusOf(error) ?? 500];
    if (code !== undefined) {
      return new ProblemError(code);
    }
    // Só o tipo do erro: mensagem e pilha podem conter dados recebidos.
    const name = error instanceof Error ? error.constructor.name : typeof error;
    this.log.error(`Falha inesperada (${name}), correlationId ${correlationIdOf(request)}`);
    return new ProblemError('INTERNAL_ERROR');
  }
}
