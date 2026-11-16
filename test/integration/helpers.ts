import { createServer } from 'node:net';

export function withApplicationName(databaseUrl: string, applicationName: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.set('application_name', applicationName);
  return url.toString();
}

/** Porta TCP local que estava livre no momento da consulta (nada escuta nela). */
export async function closedLocalPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('endereço inesperado'));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}
