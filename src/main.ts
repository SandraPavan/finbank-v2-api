import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { InvalidConfigError, loadAppConfig } from './config/app-config.js';
import { configureHttp, HTTP_APPLICATION_OPTIONS } from './http/configure-http.js';
import { DatabaseUnavailableError } from './persistence/database-errors.js';

async function bootstrap(): Promise<void> {
  const config = loadAppConfig(process.env);
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(config), {
    ...HTTP_APPLICATION_OPTIONS,
    abortOnError: false,
  });
  configureHttp(app);
  app.enableShutdownHooks();
  await app.listen(config.port);
}

try {
  await bootstrap();
} catch (error) {
  if (error instanceof InvalidConfigError || error instanceof DatabaseUnavailableError) {
    console.error(error.message);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
