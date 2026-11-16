// Healthcheck do container (Compose): consulta o mesmo contrato HTTP de readiness da API.
// Sai com 0 somente em HTTP 200; qualquer outra resposta, erro ou timeout sai com 1.
// Não imprime URL de banco nem payload.
import { parsePort } from './config/app-config.js';

const REQUEST_TIMEOUT_MS = 2_500;

try {
  const port = parsePort(process.env['PORT']);
  const response = await fetch(`http://127.0.0.1:${port}/health/ready`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  process.exitCode = response.status === 200 ? 0 : 1;
} catch {
  process.exitCode = 1;
}
