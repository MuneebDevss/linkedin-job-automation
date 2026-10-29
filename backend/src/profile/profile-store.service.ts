import {Injectable, Logger, OnModuleInit} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {access, mkdir, open, readFile, rename, unlink} from 'node:fs/promises';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {AppConfiguration} from '../config/app.config';
import {ProfileDocument, ReusableAnswer} from './profile.types';

@Injectable()
export class ProfileStoreService implements OnModuleInit {
  private readonly logger = new Logger(ProfileStoreService.name);
  private writeQueue: Promise<unknown> = Promise.resolve();

  /**
   * **Summary:** Creates the profile store with access to configured profile and template locations.
   * **Inputs:** `config` provides the active profile path and initialization template.
   * **Returns:** A profile-store instance ready for module initialization.
   */
  constructor(private readonly config: ConfigService<AppConfiguration, true>) {}

  /**
   * **Summary:** Ensures a valid profile exists at startup, initializing it from the approved template when necessary.
   * **Inputs:** No parameters; configured profile locations are used.
   * **Returns:** A promise that resolves after a valid profile is available.
   */
  async onModuleInit(): Promise<void> {
    const target = this.config.get('profilePath', {infer: true});
    try {
      await access(target);
    } catch {
      const template = this.config.get('profileTemplatePath', {infer: true});
      if (template === target) throw new Error(`Profile file does not exist: ${target}`);
      const source = await readFile(template, 'utf8');
      this.validate(JSON.parse(source));
      await this.writeAtomic(target, source);
      this.logger.log(`Initialized profile data at ${target}.`);
    }
    await this.load();
    await this.mergeMissingVerifiedDefaults();
  }

  /**
   * **Summary:** Loads and validates the profile facts, answer suggestions, resumes, and application-document catalog.
   * **Inputs:** No parameters; the configured profile file is read.
   * **Returns:** The validated profile document.
   */
  async load(): Promise<ProfileDocument> {
    const raw = await readFile(this.config.get('profilePath', {infer: true}), 'utf8');
    return this.validate(JSON.parse(raw));
  }

  /**
   * **Summary:** Adds new grounded AI-generated reusable answers without duplicating approved or previously generated records.
   * **Inputs:** `suggestions` contains reusable answers produced from form questions under their compatibility boundaries.
   * **Returns:** A promise that resolves after unique suggestions are durably stored.
   */
  async addGeneratedSuggestions(suggestions: ReusableAnswer[]): Promise<void> {
    if (!suggestions.length) return;
    await this.enqueue(async () => {
      const profile = await this.load();
      const known = new Set([
        ...profile.approvedReusableAnswers.map(item => item.id),
        ...profile.generatedSuggestions.map(item => item.id)
      ]);
      profile.generatedSuggestions.push(...suggestions.filter(item => !known.has(item.id)));
      await this.writeAtomic(
        this.config.get('profilePath', {infer: true}),
        `${JSON.stringify(profile, null, 2)}\n`
      );
    });
  }

  /**
   * **Summary:** Serializes profile updates so concurrent automation jobs cannot overwrite each other's suggestions.
   * **Inputs:** `task` is the profile update to run after earlier writes finish.
   * **Returns:** A promise that resolves when this queued update completes.
   */
  private async enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.writeQueue.then(task, task);
    this.writeQueue = next.catch(() => undefined);
    await next;
  }

  /**
   * **Summary:** Adds newly configured verified fields to an existing durable profile without replacing stored values or suggestions.
   * **Inputs:** No parameters; the active profile and configured template profile are compared.
   * **Returns:** A promise that resolves after missing top-level verified fields are merged, when needed.
   */
  private async mergeMissingVerifiedDefaults(): Promise<void> {
    const target = this.config.get('profilePath', {infer: true});
    const templatePath = this.config.get('profileTemplatePath', {infer: true});
    if (target === templatePath) return;
    const [profile, templateRaw] = await Promise.all([this.load(), readFile(templatePath, 'utf8')]);
    const template = this.validate(JSON.parse(templateRaw));
    const verified = profile.verified as unknown as Record<string, unknown>;
    const defaults = template.verified as unknown as Record<string, unknown>;
    let changed = false;
    for (const [key, value] of Object.entries(defaults)) {
      if (Object.prototype.hasOwnProperty.call(verified, key)) continue;
      verified[key] = value;
      changed = true;
    }
    if (!changed) return;
    await this.writeAtomic(target, `${JSON.stringify(profile, null, 2)}\n`);
    this.logger.log(`Added missing verified profile fields from ${templatePath}.`);
  }

  /**
   * **Summary:** Ensures profile data has the supported schema and required collections before business logic consumes it.
   * **Inputs:** `value` is the untrusted parsed profile content.
   * **Returns:** The validated profile document; invalid content causes an error.
   */
  private validate(value: unknown): ProfileDocument {
    const profile = value as Partial<ProfileDocument>;
    if (!profile || profile.schemaVersion !== 1 || !profile.verified ||
      !Array.isArray(profile.approvedReusableAnswers) || !Array.isArray(profile.generatedSuggestions) ||
      !Array.isArray(profile.resumeCatalog)) {
      throw new Error('profile.json does not match profile schema version 1.');
    }
    return profile as ProfileDocument;
  }

  /**
   * **Summary:** Replaces a profile file safely so readers never observe a partially written document.
   * **Inputs:** `path` is the target profile file; `content` is the complete validated document text.
   * **Returns:** A promise that resolves after the replacement is durable.
   */
  private async writeAtomic(path: string, content: string): Promise<void> {
    await mkdir(dirname(path), {recursive: true});
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(content, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, path);
      try {
        const directory = await open(dirname(path), 'r');
        await directory.sync();
        await directory.close();
      } catch {
        // Some platforms do not support syncing directory handles.
      }
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}
