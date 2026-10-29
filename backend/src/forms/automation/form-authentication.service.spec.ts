import {ServiceUnavailableException} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BrowserContext, Page} from 'playwright';
import {AppConfiguration} from '../../config/app.config';
import {AuthenticationStateStoreService, BrowserStorageState} from './authentication-state-store.service';
import {FormAuthenticationService} from './form-authentication.service';
import {ManualAuthenticationContextOptions, PlaywrightBrowserService} from './playwright-browser.service';

describe('FormAuthenticationService', () => {
  let directory: string;
  let states: AuthenticationStateStoreService;
  let browser: {withManualAuthenticationContext: jest.Mock};
  let service: FormAuthenticationService;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'form-auth-test-'));
    const config = new ConfigService<AppConfiguration, true>({
      formAuthStatePath: join(directory, 'state.json'),
      formAuthLoginUrl: 'https://accounts.google.com/',
      formAuthLoginTimeoutMs: 5000
    } as AppConfiguration);
    states = new AuthenticationStateStoreService(config);
    browser = {withManualAuthenticationContext: jest.fn()};
    service = new FormAuthenticationService(config, browser as unknown as PlaywrightBrowserService, states);
  });

  afterEach(async () => {
    await rm(directory, {recursive: true, force: true});
  });

  it('captures state after a successful first-time authentication', async () => {
    const harness = authenticationContext({externalBrowser: false});
    useContext(harness.context, {externalBrowser: false});

    await expect(service.authenticate()).resolves.toMatchObject({status: 'authenticated'});
    await expect(states.status()).resolves.toMatchObject({status: 'available'});
    expect(harness.page.goto).toHaveBeenCalledWith('https://accounts.google.com/', {waitUntil: 'domcontentloaded'});
  });

  it('reuses an authenticated page from the dedicated external browser profile', async () => {
    const harness = authenticationContext({externalBrowser: true, url: 'https://myaccount.google.com/'});
    useContext(harness.context, {externalBrowser: true});

    await expect(service.authenticate()).resolves.toMatchObject({status: 'authenticated'});
    expect(harness.context.newPage).not.toHaveBeenCalled();
    expect(harness.page.goto).not.toHaveBeenCalled();
    await expect(states.load()).resolves.toEqual(harness.state);
  });

  it('fails clearly on Google rejection without saving incidental cookies and permits a retry', async () => {
    const rejected = authenticationContext({
      externalBrowser: false,
      urlAfterGoto: 'https://accounts.google.com/v3/signin/rejected',
      body: "Couldn't sign you in. This browser or app may not be secure.",
      state: {
        cookies: [{
          name: 'NID', value: 'incidental', domain: '.google.com', path: '/', expires: -1,
          httpOnly: true, secure: true, sameSite: 'Lax'
        }],
        origins: []
      }
    });
    useContext(rejected.context, {externalBrowser: false});

    await expect(service.authenticate()).rejects.toThrow(ServiceUnavailableException);
    await expect(states.status()).resolves.toMatchObject({status: 'missing'});

    const successful = authenticationContext({externalBrowser: true});
    useContext(successful.context, {externalBrowser: true});
    await expect(service.authenticate()).resolves.toMatchObject({status: 'authenticated'});
  });

  function useContext(context: BrowserContext, options: ManualAuthenticationContextOptions): void {
    browser.withManualAuthenticationContext.mockImplementation(async callback => callback(context, options));
  }
});

function authenticationContext(options: {
  externalBrowser: boolean;
  url?: string;
  urlAfterGoto?: string;
  body?: string;
  state?: BrowserStorageState;
}): {context: BrowserContext; page: Page & {goto: jest.Mock}; state: BrowserStorageState} {
  let currentUrl = options.url || (options.externalBrowser ? 'https://accounts.google.com/' : 'about:blank');
  const state = options.state || {
    cookies: [{
      name: 'SID', value: 'session', domain: '.google.com', path: '/', expires: -1,
      httpOnly: true, secure: true, sameSite: 'Lax'
    }],
    origins: []
  };
  const page = {
    isClosed: jest.fn(() => false),
    url: jest.fn(() => currentUrl),
    goto: jest.fn(async (url: string) => { currentUrl = options.urlAfterGoto || url; }),
    waitForTimeout: jest.fn(async () => undefined),
    locator: jest.fn((selector: string) => selector === 'body'
      ? {innerText: jest.fn(async () => options.body || '')}
      : {count: jest.fn(async () => 0)})
  } as unknown as Page & {goto: jest.Mock};
  const context = {
    pages: jest.fn(() => options.externalBrowser ? [page] : []),
    newPage: jest.fn(async () => page),
    cookies: jest.fn(async () => state.cookies),
    storageState: jest.fn(async () => state)
  } as unknown as BrowserContext;
  return {context, page, state};
}
