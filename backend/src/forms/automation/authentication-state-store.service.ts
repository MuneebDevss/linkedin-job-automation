import {Injectable} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {randomUUID} from 'node:crypto';
import {mkdir, open, readFile, rename, stat, unlink} from 'node:fs/promises';
import {dirname} from 'node:path';
import {BrowserContext} from 'playwright';
import {AppConfiguration} from '../../config/app.config';

export type BrowserStorageState = Awaited<ReturnType<BrowserContext['storageState']>>;
export type AuthenticationStateStatus = 'missing' | 'available' | 'expired' | 'invalid';

@Injectable()
export class AuthenticationStateStoreService {
  constructor(private readonly config: ConfigService<AppConfiguration, true>) {}

  async load(): Promise<BrowserStorageState | null> {
    try {
      const state = this.validate(JSON.parse(await readFile(this.path(), 'utf8')));
      return this.stateStatus(state) === 'expired' ? null : state;
    } catch {
      return null;
    }
  }

  async status(): Promise<{status: AuthenticationStateStatus; updatedAt: string | null; path: string}> {
    const path = this.path();
    try {
      const [raw, metadata] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
      const state = this.validate(JSON.parse(raw));
      return {status: this.stateStatus(state), updatedAt: metadata.mtime.toISOString(), path};
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return {status: code === 'ENOENT' ? 'missing' : 'invalid', updatedAt: null, path};
    }
  }

  async save(state: BrowserStorageState): Promise<void> {
    this.validate(state);
    const path = this.path();
    await mkdir(dirname(path), {recursive: true, mode: 0o700});
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, path);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  private path(): string {
    return this.config.get('formAuthStatePath', {infer: true});
  }

  private stateStatus(state: BrowserStorageState): AuthenticationStateStatus {
    const now = Date.now() / 1000;
    if (state.cookies.length) {
      return state.cookies.some(cookie => cookie.expires <= 0 || cookie.expires > now) ? 'available' : 'expired';
    }
    if (state.origins.length) return 'available';
    return 'invalid';
  }

  private validate(value: unknown): BrowserStorageState {
    const state = value as Partial<BrowserStorageState>;
    if (!state || !Array.isArray(state.cookies) || !Array.isArray(state.origins)) {
      throw new Error('Authentication storage state is invalid.');
    }
    return state as BrowserStorageState;
  }
}
