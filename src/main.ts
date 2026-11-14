import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { InvalidConfigError, loadAppConfig } from './config/app-config.js';

async function bootstrap(): Promise<void> {
  const config = loadAppConfig(process.env);
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  await app.listen(config.port);
}

try {
  await bootstrap();
} catch (error) {
  if (error instanceof InvalidConfigError) {
    console.error(error.message);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
