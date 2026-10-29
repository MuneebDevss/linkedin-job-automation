import 'reflect-metadata';
import {Logger, ValidationPipe} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {NestFactory} from '@nestjs/core';
import {FastifyAdapter, NestFastifyApplication} from '@nestjs/platform-fastify';
import {AppModule} from './app.module';
import {StructuredExceptionFilter} from './common/http-exception.filter';
import {AppConfiguration} from './config/app.config';

/**
 * **Summary:** Starts the backend with validated requests, structured errors, extension-safe CORS, and configured network binding.
 * **Inputs:** No parameters; startup uses the application module and runtime configuration.
 * **Returns:** A promise that resolves once the HTTP server is listening.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({bodyLimit: 1048576})
  );
  const config = app.get(ConfigService<AppConfiguration, true>);
  app.useGlobalPipes(new ValidationPipe({whitelist: true, forbidNonWhitelisted: true, transform: true}));
  app.useGlobalFilters(new StructuredExceptionFilter());
  app.enableCors({
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'X-API-Key'],
    origin: (origin, callback) =>
      callback(null, !origin || /^(moz|chrome)-extension:\/\//.test(origin))
  });
  const host = config.get('host', {infer: true});
  const port = config.get('port', {infer: true});
  await app.listen(port, host);
  Logger.log(`Backend listening on http://${host}:${port}`, 'Bootstrap');
}

void bootstrap();
