import {ConflictException, Injectable, ServiceUnavailableException} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {AppConfiguration} from '../../config/app.config';
import {AuthenticationStateStoreService} from './authentication-state-store.service';
import {PlaywrightBrowserService} from './playwright-browser.service';

@Injectable()
export class FormAuthenticationService {
  private active = false;

  constructor(
    private readonly config: ConfigService<AppConfiguration, true>,
    private readonly browser: PlaywrightBrowserService,
    private readonly states: AuthenticationStateStoreService
  ) {}

  status() {
    return this.states.status();
  }

  async authenticate(): Promise<{status: 'authenticated'; updatedAt: string | null}> {
    if (this.active) throw new ConflictException('An authentication window is already open.');
    this.active = true;
    try {
      await this.browser.withManualAuthenticationContext(async context => {
        const page = await context.newPage();
        const loginUrl = this.config.get('formAuthLoginUrl', {infer: true});
        const loginHost = new URL(loginUrl).hostname;
        await page.goto(loginUrl, {waitUntil: 'domcontentloaded'});
        const deadline = Date.now() + this.config.get('formAuthLoginTimeoutMs', {infer: true});
        while (Date.now() < deadline) {
          const cookies = await context.cookies();
          const authenticated = cookies.some(cookie =>
            /(^|\.)google\.com$/i.test(cookie.domain) && /^(?:SID|HSID|SSID|SAPISID|__Secure-[13]PSID)$/i.test(cookie.name));
          const current = new URL(page.url());
          const genericAuthenticated = cookies.some(cookie => cookie.expires <= 0 || cookie.expires > Date.now() / 1000) &&
            !await page.locator('input[type="password"]:visible').count() &&
            (current.hostname !== loginHost || !/\/(?:signin|login|sso|auth)(?:\/|\?|$)/i.test(current.pathname));
          if (authenticated || genericAuthenticated) {
            await this.states.save(await context.storageState());
            return;
          }
          if (page.isClosed()) throw new Error('The authentication window was closed before sign-in completed.');
          await page.waitForTimeout(1000);
        }
        throw new Error('Authentication timed out before a signed-in Google session was detected.');
      });
      const status = await this.states.status();
      return {status: 'authenticated', updatedAt: status.updatedAt};
    } catch (error) {
      throw new ServiceUnavailableException(
        `Manual authentication did not complete: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      this.active = false;
    }
  }
}
