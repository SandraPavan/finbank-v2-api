import { type ArgumentsHost, Catch, type ExceptionFilter } from '@nestjs/common';
import type { HttpRequest, HttpResponse } from '../../http/http-types.js';
import { type ProblemCode, ProblemError, sendProblem } from '../../http/problem.js';
import { AuthenticationError, type AuthenticationErrorCode, RateLimitedError } from '../domain/errors.js';

const CODES: Record<AuthenticationErrorCode, ProblemCode> = {
  INVALID_CREDENTIALS: 'AUTH_INVALID_CREDENTIALS',
  SESSION_INVALID: 'AUTH_SESSION_REQUIRED',
  SESSION_EXPIRED: 'AUTH_SESSION_EXPIRED',
  PASSWORD_POLICY: 'PASSWORD_POLICY_VIOLATION',
  RATE_LIMITED: 'RATE_LIMIT_EXCEEDED',
  AUTHENTICATION_FAILED: 'TEMPORARY_UNAVAILABLE',
};

export function authenticationProblem(error: AuthenticationError): ProblemError {
  const options = error instanceof RateLimitedError ? { retryAfterSeconds: error.retryAfterSeconds } : {};
  return new ProblemError(CODES[error.code], options);
}

@Catch(AuthenticationError)
export class AuthenticationProblemFilter implements ExceptionFilter<AuthenticationError> {
  catch(error: AuthenticationError, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    sendProblem(http.getRequest<HttpRequest>(), http.getResponse<HttpResponse>(), authenticationProblem(error));
  }
}
