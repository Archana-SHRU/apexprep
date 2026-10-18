import 'reflect-metadata';
import { Logger, type LogLevel } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import type { Env } from './config/env.schema';

const LOG_LEVELS: LogLevel[] = ['error', 'warn', 'log', 'debug', 'verbose'];

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  const config = app.get<ConfigService<Env, true>>(ConfigService);
  const logLevel = config.get('LOG_LEVEL', { infer: true });
  app.useLogger(LOG_LEVELS.slice(0, LOG_LEVELS.indexOf(logLevel) + 1));

  configureApp(app);

  const port = config.get('PORT', { infer: true });
  await app.listen(port);
  Logger.log(`API listening on :${port} (NODE_ENV=${config.get('NODE_ENV', { infer: true })})`, 'Bootstrap');
}

void bootstrap();
