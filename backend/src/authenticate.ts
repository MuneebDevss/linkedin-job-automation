import {NestFactory} from '@nestjs/core';
import {AppModule} from './app.module';
import {FormAuthenticationService} from './forms/automation/form-authentication.service';

/**
 * **Summary:** Starts the standalone authentication workflow so a user can establish and save a browser login session.
 * **Inputs:** No parameters; the workflow uses the application's configured authentication services.
 * **Returns:** A promise that resolves after authentication finishes and the application context closes.
 */
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
