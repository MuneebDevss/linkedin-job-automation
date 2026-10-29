import {ConflictException, Injectable, ServiceUnavailableException} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {AppConfiguration} from '../../config/app.config';
import {AuthenticationStateStoreService, isGoogleSessionCookie} from './authentication-state-store.service';
import {PlaywrightBrowserService} from './playwright-browser.service';

@Injectable()
export class FormAuthenticationService {
  private active = false;

  /**
   * **Summary:** Creates the manual authentication coordinator with browser, state-storage, and login configuration support.
   * **Inputs:** `config` supplies login settings; `browser` opens the session; `states` persists successful authentication.
   * **Returns:** An authentication service instance ready to report or establish login state.
   */
  constructor(
    private readonly config: ConfigService<AppConfiguration, true>,
    private readonly browser: PlaywrightBrowserService,
    private readonly states: AuthenticationStateStoreService
  ) {}

  /**
   * **Summary:** Reports whether reusable form authentication is currently available.
   * **Inputs:** No parameters.
   * **Returns:** The saved authentication state's status, update time, and storage path.
   */
  status() {
    return this.states.status();
  }

  /**
   * **Summary:** Guides a user through one manual sign-in session and saves the resulting browser state for future form automation.
   * **Inputs:** No parameters; the workflow uses the configured login destination and timeout.
   * **Returns:** The authenticated status and saved-state update time after sign-in succeeds.
   */
  async authenticate(): Promise<{status: 'authenticated'; updatedAt: string | null}> {
    if (this.active) throw new ConflictException('An authentication window is already open.');
    this.active = true;
    try {
      await this.browser.withManualAuthenticationContext(async (context, options) => {
        const loginUrl = this.config.get('formAuthLoginUrl', {infer: true});
        const loginHost = new URL(loginUrl).hostname;
        const pages = context.pages().filter(candidate => !candidate.isClosed());
        const page = options.externalBrowser
          ? pages.find(candidate => this.isAuthenticationPage(candidate.url(), loginHost)) || pages[0] || await context.newPage()
          : await context.newPage();
        const initialCookies = await context.cookies();
        if (!options.externalBrowser || page.url() === 'about:blank' ||
            (!initialCookies.some(isGoogleSessionCookie) && !this.isAuthenticationPage(page.url(), loginHost))) {
          await page.goto(loginUrl, {waitUntil: 'domcontentloaded'});
        }
        const deadline = Date.now() + this.config.get('formAuthLoginTimeoutMs', {infer: true});
        while (Date.now() < deadline) {
          if (page.isClosed()) throw new Error('The authentication window was closed before sign-in completed.');
          const cookies = await context.cookies();
          const authenticated = cookies.some(cookie => isGoogleSessionCookie(cookie) && this.isCurrent(cookie.expires));
          const current = new URL(page.url());
          if (this.isRejectedSignIn(current.pathname) || await this.hasGoogleRejectionMessage(page)) {
            throw new Error(
              'Google rejected this browser session as unsupported or insecure. ' +
              'Use FORM_AUTH_CDP_URL with a separately launched Chrome instance and a dedicated profile.'
            );
          }
          const genericAuthenticated = !/(^|\.)google\.com$/i.test(loginHost) &&
            cookies.some(cookie => this.isCurrent(cookie.expires)) &&
            !await page.locator('input[type="password"]:visible').count() &&
            current.hostname !== loginHost && !this.isAuthenticationPath(current.pathname);
          if (authenticated || genericAuthenticated) {
            await this.states.save(await context.storageState());
            return;
          }
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

  /**
   * **Summary:** Determines whether a browser cookie has no expiry or remains valid at the current time.
   * **Inputs:** `expires` is the cookie expiry expressed as a Unix timestamp in seconds.
   * **Returns:** `true` when the cookie is current, otherwise `false`.
   */
  private isCurrent(expires: number): boolean {
    return expires <= 0 || expires > Date.now() / 1000;
  }

  /**
   * **Summary:** Determines whether a browser page belongs to the configured login provider or Google authentication.
   * **Inputs:** `value` is the page URL; `loginHost` is the configured authentication host.
   * **Returns:** `true` when the page is part of the authentication journey, otherwise `false`.
   */
  private isAuthenticationPage(value: string, loginHost: string): boolean {
    try {
      const url = new URL(value);
      return url.hostname === loginHost || /(^|\.)google\.com$/i.test(url.hostname);
    } catch {
      return false;
    }
  }

  /**
   * **Summary:** Recognizes common sign-in route patterns so the service does not mistake an authentication page for a completed login.
   * **Inputs:** `pathname` is the current page's URL path.
   * **Returns:** `true` when the path represents an authentication route, otherwise `false`.
   */
  private isAuthenticationPath(pathname: string): boolean {
    return /\/(?:v\d+\/)?(?:signin|login|sso|auth)(?:\/|$)/i.test(pathname);
  }

  /**
   * **Summary:** Recognizes provider routes that explicitly indicate a rejected sign-in attempt.
   * **Inputs:** `pathname` is the current page's URL path.
   * **Returns:** `true` when the route reports a rejected sign-in, otherwise `false`.
   */
  private isRejectedSignIn(pathname: string): boolean {
    return /\/(?:v\d+\/)?signin\/rejected(?:\/|$)/i.test(pathname);
  }

  /**
   * **Summary:** Detects Google's user-facing insecure-browser rejection so the authentication workflow can provide actionable guidance.
   * **Inputs:** `page` is the active authentication page.
   * **Returns:** A promise resolving to `true` when the rejection message is present, otherwise `false`.
   */
  private async hasGoogleRejectionMessage(page: import('playwright').Page): Promise<boolean> {
    const body = await page.locator('body').innerText({timeout: 1000}).catch(() => '');
    return /couldn[’']t sign you in[\s\S]{0,500}(?:browser|app) may not be secure/i.test(body);
  }
}
