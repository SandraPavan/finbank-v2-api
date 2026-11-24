import type { CookieTransport } from '../../config/app-config.js';
import { type HttpRequest, type HttpResponse, header } from '../../http/http-types.js';
import { ProblemError } from '../../http/problem.js';

const SECRET = /^[A-Za-z0-9_-]{43}$/;

export interface ContextCookies {
  readonly session: string | undefined;
  readonly preauth: string | undefined;
}

/** Cookies de sessão e de contexto pré-autenticado. Sem Domain e sem Max-Age: o prazo é do servidor. */
export class ContextCookieJar {
  private readonly sessionName: string;
  private readonly preauthName: string;
  private readonly attributes: string;

  constructor(transport: CookieTransport) {
    const secure = transport === 'secure';
    const prefix = secure ? '__Host-' : '';
    this.sessionName = `${prefix}finbank_session`;
    this.preauthName = `${prefix}finbank_preauth`;
    this.attributes = `Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
  }

  /** Nome repetido é recusado: não há como saber qual valor é o legítimo. Valor malformado é ignorado. */
  read(request: HttpRequest): ContextCookies {
    const found = new Map<string, string>();
    for (const part of (header(request, 'cookie') ?? '').split(';')) {
      const separator = part.indexOf('=');
      const name = part.slice(0, Math.max(separator, 0)).trim();
      if (name === this.sessionName || name === this.preauthName) {
        if (found.has(name)) {
          throw new ProblemError('VALIDATION_ERROR');
        }
        found.set(name, part.slice(separator + 1).trim());
      }
    }
    const secret = (name: string): string | undefined => {
      const value = found.get(name);
      return value !== undefined && SECRET.test(value) ? value : undefined;
    };
    return { session: secret(this.sessionName), preauth: secret(this.preauthName) };
  }

  setSession(response: HttpResponse, secret: string): void {
    append(response, `${this.sessionName}=${secret}; ${this.attributes}`);
  }

  setPreauth(response: HttpResponse, secret: string): void {
    append(response, `${this.preauthName}=${secret}; ${this.attributes}`);
  }

  clearSession(response: HttpResponse): void {
    append(response, this.expired(this.sessionName));
  }

  clearPreauth(response: HttpResponse): void {
    append(response, this.expired(this.preauthName));
  }

  private expired(name: string): string {
    return `${name}=; ${this.attributes}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
  }
}

function append(response: HttpResponse, cookie: string): void {
  const current = response.getHeader('Set-Cookie');
  response.setHeader('Set-Cookie', [...(Array.isArray(current) ? current : []), cookie]);
}
