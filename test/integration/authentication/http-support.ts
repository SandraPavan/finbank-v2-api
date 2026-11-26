// Cliente HTTP dos testes de autenticação: cookies explícitos e toda resposta conferida contra o OpenAPI.
import type { Type } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { spec } from 'pactum';
import { expect, inject } from 'vitest';
import { AppModule } from '../../../src/app.module.js';
import { loadAppConfig } from '../../../src/config/app-config.js';
import { configureHttp, HTTP_APPLICATION_OPTIONS } from '../../../src/http/configure-http.js';
import { OPENAPI_DOCUMENT } from '../../../src/http/openapi.js';

export type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export async function startApp(env: Record<string, string> = {}, controllers: Type[] = [], overrides: [unknown, unknown][] = []): Promise<{ app: NestExpressApplication; url: string }> {
  const config = { ...loadAppConfig({ DATABASE_URL: inject('appDatabaseUrl'), ...env }), port: 0 };
  let builder = Test.createTestingModule({ imports: [AppModule.forRoot(config)], controllers });
  for (const [token, value] of overrides) {
    builder = builder.overrideProvider(token).useValue(value);
  }
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ ...HTTP_APPLICATION_OPTIONS, logger: false });
  configureHttp(app);
  await app.listen(0, '127.0.0.1');
  return { app, url: await app.getUrl() };
}

export interface Reply {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: Record<string, unknown>;
  readonly text: string;
  readonly setCookies: readonly string[];
}

type Json = Record<string, unknown>;

/** Resolve $ref locais para o validador do PactumJS. */
function inline(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map(inline);
  }
  if (typeof schema !== 'object' || schema === null) {
    return schema;
  }
  const ref = (schema as Json)['$ref'];
  if (typeof ref === 'string') {
    const target = ref.slice(2).split('/').reduce<unknown>((node, key) => (node as Json)[key], OPENAPI_DOCUMENT);
    return inline(target);
  }
  return Object.fromEntries(Object.entries(schema).map(([k, v]) => [k, inline(v)]));
}

/** Caminho do contrato que atende à URL, com ou sem parâmetros. */
export function contractPath(url: string): string | undefined {
  const path = url.split('?')[0] ?? '';
  return Object.keys(OPENAPI_DOCUMENT.paths).find((p) => new RegExp(`^${p.replace(/[.]/g, '\\.').replace(/\{[^}]+\}/g, '[^/]+')}$`).test(path));
}

export interface CallOptions {
  readonly headers?: Record<string, string>;
  readonly json?: unknown;
  readonly raw?: string;
}

export async function call(url: string, method: Method, path: string, options: CallOptions = {}): Promise<Reply> {
  const request = spec()[method === 'GET' ? 'get' : method === 'POST' ? 'post' : method === 'PATCH' ? 'patch' : 'delete'](`${url}${path}`).withHeaders(options.headers ?? {});
  if (options.json !== undefined) {
    request.withHeaders('content-type', 'application/json').withBody(JSON.stringify(options.json));
  } else if (options.raw !== undefined) {
    request.withBody(options.raw);
  }
  const response = (await request.toss()) as {
    statusCode: number;
    headers: Reply['headers'];
    json: unknown;
    text?: string;
  };
  const paths = OPENAPI_DOCUMENT.paths as Record<string, Record<string, { responses: Record<string, { content?: Json }> }>>;
  const operation = paths[contractPath(path) ?? '']?.[method.toLowerCase()];
  if (operation !== undefined) {
    const documented = operation.responses[String(response.statusCode)];
    expect(documented, `${method} ${path} ${response.statusCode} não documentado`).toBeDefined();
    const [type, media] = Object.entries(documented?.content ?? {})[0] ?? [];
    if (type === undefined) {
      expect(response.text ?? '').toBe('');
    } else {
      expect(response.headers['content-type']).toContain(type);
      const schema = inline((media as Json)['schema']) as Json;
      request.response().to.have.jsonSchema(schema);
    }
  }
  expect(response.headers['x-correlation-id']).toMatch(/^[A-Za-z0-9._-]{8,64}$/);
  const cookies = response.headers['set-cookie'];
  return {
    status: response.statusCode,
    headers: response.headers,
    body: (typeof response.json === 'object' && response.json !== null ? response.json : {}) as Json,
    text: response.text ?? JSON.stringify(response.json ?? ''),
    setCookies: Array.isArray(cookies) ? cookies : cookies === undefined ? [] : [cookies],
  };
}

/** Contexto de navegador: guarda cookies e o último token CSRF. */
export class Browser {
  readonly jar = new Map<string, string>();
  token = '';

  constructor(
    private readonly url: string,
    private readonly extra: Record<string, string> = {},
  ) {}

  get cookie(): string {
    return [...this.jar].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  send(method: Method, path: string, json?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
    return this.api(method, `/auth${path}`, json, headers);
  }

  async api(method: Method, path: string, json?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
    const reply = await call(this.url, method, `/api/v1${path}`, {
      ...(json === undefined ? {} : { json }),
      headers: {
        ...this.extra,
        ...(this.jar.size === 0 ? {} : { cookie: this.cookie }),
        ...(method !== 'GET' && this.token !== '' ? { 'x-csrf-token': this.token } : {}),
        ...headers,
      },
    });
    for (const line of reply.setCookies) {
      const [pair = ''] = line.split(';');
      const [name = '', value = ''] = pair.split('=');
      if (value === '') {
        this.jar.delete(name);
      } else {
        this.jar.set(name, value);
      }
    }
    if (typeof reply.body['csrfToken'] === 'string') {
      this.token = reply.body['csrfToken'];
    }
    return reply;
  }

  async login(person: { alias: string | null; email: string }, password: string): Promise<Reply> {
    if (this.jar.size === 0) {
      await this.send('GET', '/csrf');
    }
    return person.alias === null
      ? this.send('POST', '/facilitator/login', { email: person.email, password })
      : this.send('POST', '/customer/login', { alias: person.alias, email: person.email, password });
  }
}
