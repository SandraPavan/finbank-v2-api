import { type ArgumentsHost, Catch, type ExceptionFilter } from '@nestjs/common';
import { AuthenticationError } from '../../authentication/domain/errors.js';
import { authenticationProblem } from '../../authentication/http/authentication-problem.filter.js';
import type { HttpRequest, HttpResponse } from '../../http/http-types.js';
import { type ProblemCode, ProblemError, sendProblem } from '../../http/problem.js';
import { IdentityError, type IdentityErrorCode } from '../../identity/domain/errors.js';

/** Negação e identificador malformado são o mesmo 404: não revelam o que existe. */
const CODES: Partial<Record<IdentityErrorCode, ProblemCode>> = {
  ACCESS_DENIED: 'RESOURCE_NOT_FOUND',
  INVALID_INPUT: 'RESOURCE_NOT_FOUND',
  ACCESS_CHECK_FAILED: 'TEMPORARY_UNAVAILABLE',
};

/** Traduz erros conhecidos; os demais seguem como recebidos. */
export function accessProblem(error: unknown): unknown {
  if (error instanceof AuthenticationError) {
    return authenticationProblem(error);
  }
  if (error instanceof IdentityError) {
    return new ProblemError(CODES[error.code] ?? 'INTERNAL_ERROR');
  }
  return error;
}

/** Erros de identidade surgidos depois da guarda. */
@Catch(IdentityError)
export class IdentityProblemFilter implements ExceptionFilter<IdentityError> {
  catch(error: IdentityError, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    sendProblem(http.getRequest<HttpRequest>(), http.getResponse<HttpResponse>(), accessProblem(error) as ProblemError);
  }
}
