import {CanActivate, ExecutionContext, Injectable, UnauthorizedException} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {timingSafeEqual} from 'node:crypto';
import {AppConfiguration} from '../config/app.config';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  /**
   * **Summary:** Creates an API guard that applies the application's configured access token policy.
   * **Inputs:** `config` provides the API token used to protect incoming requests.
   * **Returns:** A guard instance ready to authorize HTTP requests.
   */
  constructor(private readonly config: ConfigService<AppConfiguration, true>) {}

  /**
   * **Summary:** Allows requests with the configured API key and rejects unauthorized callers when token protection is enabled.
   * **Inputs:** `context` provides the incoming HTTP request and its API-key header.
   * **Returns:** `true` when the request may continue; otherwise the function throws an authorization error.
   */
  canActivate(context: ExecutionContext): boolean {
    const expected = this.config.get('apiToken', {infer: true});
    if (!expected) return true;
    const provided = String(context.switchToHttp().getRequest().headers['x-api-key'] || '');
    const a = Buffer.from(expected);
    const b = Buffer.from(provided);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new UnauthorizedException('Invalid API token.');
    return true;
  }
}
