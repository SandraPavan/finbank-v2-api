import { type ArgumentsHost, Catch, type ExceptionFilter } from '@nestjs/common';
import type { HttpRequest, HttpResponse } from '../../http/http-types.js';
import { ProblemError, sendProblem } from '../../http/problem.js';
import { AdministrationError } from '../domain/errors.js';

@Catch(AdministrationError)
export class AdministrationProblemFilter implements ExceptionFilter<AdministrationError> {
  catch(error: AdministrationError, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const code = error.code === 'IDENTITY_STATE' ? 'IDENTITY_STATE_CONFLICT' : 'INTERNAL_ERROR';
    sendProblem(http.getRequest<HttpRequest>(), http.getResponse<HttpResponse>(), new ProblemError(code));
  }
}
