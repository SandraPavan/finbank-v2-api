/** Subconjuntos de requisição e resposta usados aqui, sem acoplar ao Express. */
export interface HttpRequest {
  readonly method: string;
  readonly originalUrl: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body?: unknown;
  correlationId?: string;
}

export interface HttpResponse {
  readonly headersSent: boolean;
  status(code: number): HttpResponse;
  setHeader(name: string, value: string | string[]): unknown;
  getHeader(name: string): number | string | string[] | undefined;
  type(value: string): HttpResponse;
  send(body: string): unknown;
}

/** Rotas do Express não diferenciam maiúsculas: a comparação também não. */
export function isApiPath(url: string): boolean {
  return /^\/api\/v1(\/|\?|$)/i.test(url);
}

export function header(request: HttpRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
}
