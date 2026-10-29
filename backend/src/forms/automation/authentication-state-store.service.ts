import {Injectable} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {randomUUID} from 'node:crypto';
import {mkdir, open, readFile, rename, stat, unlink} from 'node:fs/promises';
import {dirname} from 'node:path';
import {BrowserContext} from 'playwright';
import {AppConfiguration} from '../../config/app.config';

export type BrowserStorageState = Awaited<ReturnType<BrowserContext['storageState']>>;
export type AuthenticationStateStatus = 'missing' | 'available' | 'expired' | 'invalid';

/**
 * **Summary:** Identifies cookies that represent an authenticated Google session and can support automated form access.
 * **Inputs:** `cookie` provides the cookie domain and name to evaluate.
 * **Returns:** `true` when the cookie is a recognized Google session cookie, otherwise `false`.
 */
export function isGoogleSessionCookie(cookie: {domain: string; name: string}): boolean {
  return /(^|\.)google\.com$/i.test(cookie.domain) &&
    /^(?:SID|HSID|SSID|SAPISID|__Secure-[13]PSID)$/i.test(cookie.name);
}

@Injectable()
export class AuthenticationStateStoreService {
  /**
   * **Summary:** Creates the authentication-state store using the application's configured secure state location.
   * **Inputs:** `config` provides the path where reusable browser authentication is stored.
   * **Returns:** A state-store instance ready to load, inspect, and save authentication state.
   */
  constructor(private readonly config: ConfigService<AppConfiguration, true>) {}

  /**
   * **Summary:** Loads reusable browser authentication when the stored data is valid and still current.
   * **Inputs:** No parameters; the configured authentication-state file is used.
   * **Returns:** The usable browser state, or `null` when it is missing, invalid, expired, or unreadable.
   */
  async load(): Promise<BrowserStorageState | null> {
    try {
      const state = this.validate(JSON.parse(await readFile(this.path(), 'utf8')));
      return this.stateStatus(state) === 'expired' ? null : state;
    } catch {
      return null;
    }
  }

  /**
   * **Summary:** Reports whether saved browser authentication is available for form automation and when it was last updated.
   * **Inputs:** No parameters; the configured authentication-state file is inspected.
   * **Returns:** The authentication status, last-update timestamp, and state-file path.
   */
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

  /**
   * **Summary:** Persists validated browser authentication so later automation jobs can reuse the signed-in session.
   * **Inputs:** `state` contains the browser cookies and origin storage to preserve.
   * **Returns:** A promise that resolves after the state has been saved securely.
   */
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

  /**
   * **Summary:** Provides the configured location of the reusable browser authentication state.
   * **Inputs:** No parameters.
   * **Returns:** The authentication-state file path.
   */
  private path(): string {
    return this.config.get('formAuthStatePath', {infer: true});
  }

  /**
   * **Summary:** Classifies validated browser state by whether it contains current session data suitable for reuse.
   * **Inputs:** `state` contains validated browser cookies and origin storage.
   * **Returns:** `available`, `expired`, or `invalid` according to the state's reusable authentication data.
   */
  private stateStatus(state: BrowserStorageState): AuthenticationStateStatus {
    const now = Date.now() / 1000;
    if (state.cookies.length) {
      const googleSessionCookies = state.cookies.filter(isGoogleSessionCookie);
      const relevantCookies = googleSessionCookies.length ? googleSessionCookies : state.cookies;
      return relevantCookies.some(cookie => cookie.expires <= 0 || cookie.expires > now) ? 'available' : 'expired';
    }
    if (state.origins.length) return 'available';
    return 'invalid';
  }

  /**
   * **Summary:** Ensures loaded or submitted authentication data has the browser storage structure required by automation.
   * **Inputs:** `value` is the untrusted authentication-state value to check.
   * **Returns:** The validated browser storage state; invalid values cause an error.
   */
  private validate(value: unknown): BrowserStorageState {
    const state = value as Partial<BrowserStorageState>;
    if (!state || !Array.isArray(state.cookies) || !Array.isArray(state.origins)) {
      throw new Error('Authentication storage state is invalid.');
    }
    return state as BrowserStorageState;
  }
}
