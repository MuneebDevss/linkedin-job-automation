import {CanActivate, ExecutionContext, Injectable, UnauthorizedException} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {timingSafeEqual} from 'node:crypto';
import {AppConfiguration} from '../config/app.config';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly config: ConfigService<AppConfiguration, true>) {}

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
