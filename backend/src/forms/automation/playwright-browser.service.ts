import {Injectable, Logger, OnModuleDestroy} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {Browser, BrowserContext, chromium} from 'playwright';
import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import {AppConfiguration} from '../../config/app.config';
import {AuthenticationStateStoreService} from './authentication-state-store.service';

export interface ManualAuthenticationContextOptions {
  externalBrowser: boolean;
}

@Injectable()
export class PlaywrightBrowserService implements OnModuleDestroy {
  private readonly logger = new Logger(PlaywrightBrowserService.name);
  private browser: Browser | null = null;
  private launching: Promise<Browser> | null = null;

  /**
   * **Summary:** Creates the browser service with access to application settings and saved authentication state.
   * **Inputs:** `config` provides browser and form settings; `authenticationStates` supplies reusable login state.
   * **Returns:** A configured service instance for managing form-automation browser sessions.
   */
  constructor(
    private readonly config: ConfigService<AppConfiguration, true>,
    private readonly authenticationStates: AuthenticationStateStoreService
  ) {}

  /**
   * **Summary:** Runs a form-automation job in its own browser context so jobs remain isolated while reusing saved authentication.
   * **Inputs:** `jobId` identifies the job for policy reporting; `task` contains the work to perform in the isolated context.
   * **Returns:** The value produced by the task after the browser context has been cleaned up.
   */
  async withIsolatedContext<T>(jobId: string, task: (context: BrowserContext) => Promise<T>): Promise<T> {
    const browser = await this.getBrowser();
    const storageState = await this.authenticationStates.load();
    const context = await browser.newContext({
      acceptDownloads: false,
      locale: 'en-US',
      serviceWorkers: 'block',
      viewport: {width: 1440, height: 1000},
      ...(storageState ? {storageState} : {})
    });
    context.setDefaultTimeout(this.config.get('formTimeoutMs', {infer: true}));
    context.setDefaultNavigationTimeout(this.config.get('formNavigationTimeoutMs', {infer: true}));
    await this.installNetworkPolicy(context, jobId);
    try {
      return await task(context);
    } finally {
      await context.close().catch(error => this.logger.warn(`Context cleanup failed: ${String(error)}`));
    }
  }

  /**
   * **Summary:** Runs an interactive authentication flow in either a configured external browser or a dedicated local browser.
   * **Inputs:** `task` performs the authentication flow and receives the context plus whether the browser is externally managed.
   * **Returns:** The value produced by the authentication task after the managed browser resources have been released.
   */
  async withManualAuthenticationContext<T>(
    task: (context: BrowserContext, options: ManualAuthenticationContextOptions) => Promise<T>
  ): Promise<T> {
    const cdpUrl = this.config.get('formAuthCdpUrl', {infer: true});
    if (cdpUrl) return this.withExternalAuthenticationContext(cdpUrl, task);

    const executablePath = this.config.get('playwrightBrowserExecutablePath', {infer: true});
    const browser = await chromium.launch({
      headless: false,
      ...(executablePath ? {executablePath} : {}),
      args: ['--disable-dev-shm-usage']
    });
    const storageState = await this.authenticationStates.load();
    const context = await browser.newContext({
      locale: 'en-US',
      viewport: {width: 1280, height: 900},
      ...(storageState ? {storageState} : {})
    });
    context.setDefaultTimeout(this.config.get('formAuthLoginTimeoutMs', {infer: true}));
    await this.installNetworkPolicy(context, 'manual-authentication');
    try {
      return await task(context, {externalBrowser: false});
    } finally {
      await context.close().catch(() => undefined);
      await browser.close().catch(() => undefined);
    }
  }

  /**
   * **Summary:** Runs an interactive authentication flow through an existing browser so users can sign in with their normal browser environment.
   * **Inputs:** `cdpUrl` identifies the external browser connection; `task` performs authentication in its available context.
   * **Returns:** The value produced by the authentication task without closing the externally managed browser process.
   */
  private async withExternalAuthenticationContext<T>(
    cdpUrl: string,
    task: (context: BrowserContext, options: ManualAuthenticationContextOptions) => Promise<T>
  ): Promise<T> {
    const browser = await chromium.connectOverCDP(cdpUrl, {
      noDefaults: true,
      timeout: Math.min(this.config.get('formAuthLoginTimeoutMs', {infer: true}), 30000)
    });
    const context = browser.contexts()[0];
    if (!context) {
      await browser.close().catch(() => undefined);
      throw new Error('The external Chrome instance did not expose a default browser context.');
    }
    context.setDefaultTimeout(this.config.get('formAuthLoginTimeoutMs', {infer: true}));
    await this.installNetworkPolicy(context, 'manual-authentication');
    try {
      return await task(context, {externalBrowser: true});
    } finally {
      // For a CDP attachment this closes Playwright's transport. It does not own
      // or close the separately launched Chrome process or its persistent profile.
      await browser.close().catch(() => undefined);
    }
  }

  /**
   * **Summary:** Shuts down the shared automation browser when the application module is destroyed to prevent orphaned sessions.
   * **Inputs:** No parameters.
   * **Returns:** A promise that resolves after the shared browser reference has been cleared.
   */
  async onModuleDestroy(): Promise<void> {
    await this.browser?.close().catch(() => undefined);
    this.browser = null;
  }

  /**
   * **Summary:** Provides a healthy shared browser for automation jobs, creating one only when no connected browser is available.
   * **Inputs:** No parameters; browser behavior comes from the application configuration.
   * **Returns:** The connected shared browser used to create isolated job contexts.
   */
  private async getBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    if (!this.launching) {
      const executablePath = this.config.get('playwrightBrowserExecutablePath', {infer: true});
      this.launching = chromium.launch({
        headless: this.config.get('playwrightHeadless', {infer: true}),
        ...(executablePath ? {executablePath} : {}),
        args: ['--disable-dev-shm-usage']
      }).then(browser => {
        this.browser = browser;
        browser.on('disconnected', () => { this.browser = null; });
        return browser;
      }).finally(() => { this.launching = null; });
    }
    return this.launching;
  }

  /**
   * **Summary:** Applies the service's network-safety rules to a browser context so automation cannot access restricted destinations.
   * **Inputs:** `context` is the browser session to protect; `operation` identifies the activity in policy warnings.
   * **Returns:** A promise that resolves once the network policy is active for the context.
   */
  private async installNetworkPolicy(context: BrowserContext, operation: string): Promise<void> {
    await context.route('**/*', async route => {
      const url = route.request().url();
      if (await this.isUnsafeNetworkUrl(url)) {
        this.logger.warn(`Blocked a network-local browser request during ${operation}.`);
        await route.abort('blockedbyclient');
      } else {
        await route.continue();
      }
    });
  }

  /**
   * **Summary:** Determines whether a destination should be blocked to protect automation from unsafe protocols and private networks.
   * **Inputs:** `value` is the destination URL requested by the browser.
   * **Returns:** `true` when the destination must be blocked, otherwise `false`.
   */
  private async isUnsafeNetworkUrl(value: string): Promise<boolean> {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return true;
    }
    if (['data:', 'blob:', 'about:'].includes(url.protocol)) return false;
    if (!['http:', 'https:'].includes(url.protocol)) return true;
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (this.config.get('formAllowLocalhost', {infer: true}) && (host === '127.0.0.1' || host === 'localhost')) return false;
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true;
    try {
      const addresses = isIP(host) ? [host] : (await lookup(host, {all: true, verbatim: true})).map(item => item.address);
      return !addresses.length || addresses.some(address => this.isPrivateAddress(address));
    } catch {
      return true;
    }
  }

  /**
   * **Summary:** Identifies IP addresses that represent private, local, reserved, or otherwise restricted network destinations.
   * **Inputs:** `address` is an IPv4 or IPv6 address resolved from a browser request.
   * **Returns:** `true` when the address belongs to a restricted range, otherwise `false`.
   */
  private isPrivateAddress(address: string): boolean {
    const host = address.toLowerCase();
    if (host.includes(':')) {
      return host === '::' || host === '::1' || host.startsWith('::ffff:') || host.startsWith('fc') ||
        host.startsWith('fd') || /^fe[89ab]/.test(host);
    }
    const parts = host.split('.').map(Number);
    return parts[0] === 0 || parts[0] === 10 || parts[0] === 127 || parts[0] >= 224 ||
      (parts[0] === 169 && parts[1] === 254) || (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) ||
      (parts[0] === 192 && parts[1] === 0) || (parts[0] === 198 && [18, 19].includes(parts[1])) ||
      (parts[0] === 198 && parts[1] === 51 && parts[2] === 100) ||
      (parts[0] === 203 && parts[1] === 0 && parts[2] === 113);
  }
}
