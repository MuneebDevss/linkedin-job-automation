import {Injectable, Logger, OnModuleDestroy} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {Browser, BrowserContext, chromium} from 'playwright';
import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import {AppConfiguration} from '../../config/app.config';
import {AuthenticationStateStoreService} from './authentication-state-store.service';

@Injectable()
export class PlaywrightBrowserService implements OnModuleDestroy {
  private readonly logger = new Logger(PlaywrightBrowserService.name);
  private browser: Browser | null = null;
  private launching: Promise<Browser> | null = null;

  constructor(
    private readonly config: ConfigService<AppConfiguration, true>,
    private readonly authenticationStates: AuthenticationStateStoreService
  ) {}

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

  async withManualAuthenticationContext<T>(task: (context: BrowserContext) => Promise<T>): Promise<T> {
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
      return await task(context);
    } finally {
      await context.close().catch(() => undefined);
      await browser.close().catch(() => undefined);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.browser?.close().catch(() => undefined);
    this.browser = null;
  }

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
