import {ConfigService} from '@nestjs/config';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AppConfiguration} from '../../config/app.config';
import {AuthenticationStateStoreService, BrowserStorageState} from './authentication-state-store.service';

describe('AuthenticationStateStoreService', () => {
  let directory: string;
  let path: string;
  let states: AuthenticationStateStoreService;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'auth-state-test-'));
    path = join(directory, 'nested', 'state.json');
    const config = new ConfigService<AppConfiguration, true>({formAuthStatePath: path} as AppConfiguration);
    states = new AuthenticationStateStoreService(config);
  });

  afterEach(async () => {
    await rm(directory, {recursive: true, force: true});
  });

  it('reports a missing first-time authentication state', async () => {
    await expect(states.load()).resolves.toBeNull();
    await expect(states.status()).resolves.toMatchObject({status: 'missing', updatedAt: null, path});
  });

  it('saves and reloads a reusable authenticated session', async () => {
    const state = googleState(-1);
    await states.save(state);

    await expect(states.load()).resolves.toEqual(state);
    await expect(states.status()).resolves.toMatchObject({status: 'available', path});
  });

  it('treats expired Google session cookies as expired even when an unrelated cookie is current', async () => {
    const state = googleState(1);
    state.cookies.push({
      name: 'NID', value: 'preferences', domain: '.google.com', path: '/', expires: Date.now() / 1000 + 3600,
      httpOnly: true, secure: true, sameSite: 'Lax'
    });
    await states.save(state);

    await expect(states.load()).resolves.toBeNull();
    await expect(states.status()).resolves.toMatchObject({status: 'expired'});
  });

  it('reports malformed state as invalid instead of loading it', async () => {
    await mkdir(join(directory, 'nested'), {recursive: true});
    await writeFile(path, '{"cookies":[]}', 'utf8');

    await expect(states.load()).resolves.toBeNull();
    await expect(states.status()).resolves.toMatchObject({status: 'invalid'});
  });
});

function googleState(expires: number): BrowserStorageState {
  return {
    cookies: [{
      name: 'SID', value: 'session', domain: '.google.com', path: '/', expires,
      httpOnly: true, secure: true, sameSite: 'Lax'
    }],
    origins: []
  };
}
