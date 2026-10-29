import {ConfigService} from '@nestjs/config';
import {Browser, BrowserContext, chromium} from 'playwright';
import {AppConfiguration} from '../../config/app.config';
import {AuthenticationStateStoreService} from './authentication-state-store.service';
import {PlaywrightBrowserService} from './playwright-browser.service';

describe('PlaywrightBrowserService authentication contexts', () => {
  afterEach(() => jest.restoreAllMocks());

  it('attaches to a dedicated external Chrome context without closing that context', async () => {
    const context = {
      setDefaultTimeout: jest.fn(),
      route: jest.fn(),
      close: jest.fn()
    } as unknown as BrowserContext;
    const attachedBrowser = {
      contexts: jest.fn(() => [context]),
      close: jest.fn(async () => undefined)
    } as unknown as Browser;
    const connect = jest.spyOn(chromium, 'connectOverCDP').mockResolvedValue(attachedBrowser);
    const config = new ConfigService<AppConfiguration, true>({
      formAuthCdpUrl: 'http://127.0.0.1:9222',
      formAuthLoginTimeoutMs: 5000,
      formAllowLocalhost: false
    } as AppConfiguration);
    const states = {} as AuthenticationStateStoreService;
    const service = new PlaywrightBrowserService(config, states);

    const result = await service.withManualAuthenticationContext(async (received, options) => {
      expect(received).toBe(context);
      expect(options).toEqual({externalBrowser: true});
      return 'captured';
    });

    expect(result).toBe('captured');
    expect(connect).toHaveBeenCalledWith('http://127.0.0.1:9222', {noDefaults: true, timeout: 5000});
    expect(context.close).not.toHaveBeenCalled();
    expect(attachedBrowser.close).toHaveBeenCalled();
  });
});
