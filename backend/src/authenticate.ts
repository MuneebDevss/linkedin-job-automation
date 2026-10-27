import {NestFactory} from '@nestjs/core';
import {AppModule} from './app.module';
import {FormAuthenticationService} from './forms/automation/form-authentication.service';

async function authenticate(): Promise<void> {
  const application = await NestFactory.createApplicationContext(AppModule, {logger: ['error', 'warn', 'log']});
  try {
    const result = await application.get(FormAuthenticationService).authenticate();
    console.log(`Authentication session saved at ${result.updatedAt || 'the current time'}.`);
  } finally {
    await application.close();
  }
}

authenticate().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
