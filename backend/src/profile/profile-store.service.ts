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

  constructor(private readonly config: ConfigService<AppConfiguration, true>) {}

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
  }

  async load(): Promise<ProfileDocument> {
    const raw = await readFile(this.config.get('profilePath', {infer: true}), 'utf8');
    return this.validate(JSON.parse(raw));
  }

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

  private async enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.writeQueue.then(task, task);
    this.writeQueue = next.catch(() => undefined);
    await next;
  }

  private validate(value: unknown): ProfileDocument {
    const profile = value as Partial<ProfileDocument>;
    if (!profile || profile.schemaVersion !== 1 || !profile.verified ||
      !Array.isArray(profile.approvedReusableAnswers) || !Array.isArray(profile.generatedSuggestions) ||
      !Array.isArray(profile.resumeCatalog)) {
      throw new Error('profile.json does not match profile schema version 1.');
    }
    return profile as ProfileDocument;
  }

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
