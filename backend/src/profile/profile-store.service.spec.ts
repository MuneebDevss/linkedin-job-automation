import {ConfigService} from '@nestjs/config';
import {mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {ProfileStoreService} from './profile-store.service';

describe('ProfileStoreService', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'job-profile-'));
  });

  afterEach(async () => {
    await rm(directory, {recursive: true, force: true});
  });

  it('atomically stores generated suggestions separately from verified fields', async () => {
    const service = new ProfileStoreService(new ConfigService({
      profilePath: join(directory, 'profile.json'),
      profileTemplatePath: resolve('data/profile.json')
    }) as never);
    await service.onModuleInit();
    const before = await service.load();
    await service.addGeneratedSuggestions([{
      id: 'suggestion-1', question: 'Why join?', normalizedQuestion: 'why join',
      fieldType: 'long_text', answer: 'I enjoy building useful products.', confidence: 'high',
      approved: false, provenance: {source: 'gemini'},
      createdAt: '2026-10-27T00:00:00.000Z', updatedAt: '2026-10-27T00:00:00.000Z'
    }]);
    const after = await service.load();
    expect(after.verified).toEqual(before.verified);
    expect(after.approvedReusableAnswers).toEqual([]);
    expect(after.generatedSuggestions).toEqual([expect.objectContaining({id: 'suggestion-1', approved: false})]);
    expect((await readdir(directory)).some(file => file.endsWith('.tmp'))).toBe(false);
  });

  it('adds only missing verified template fields to an existing durable profile', async () => {
    const templatePath = resolve('data/profile.json');
    const existing = JSON.parse(await readFile(templatePath, 'utf8'));
    delete existing.verified.currentSalary;
    delete existing.verified.reasonForLeaving;
    existing.verified.name = 'Existing Name Must Win';
    existing.generatedSuggestions = [{
      id: 'existing', question: 'Existing?', normalizedQuestion: 'existing', fieldType: 'text', answer: 'Yes',
      confidence: 'high', approved: true, provenance: {source: 'gemini'},
      createdAt: '2026-10-30T00:00:00.000Z', updatedAt: '2026-10-30T00:00:00.000Z'
    }];
    const target = join(directory, 'profile.json');
    await writeFile(target, JSON.stringify(existing), 'utf8');
    const service = new ProfileStoreService(new ConfigService({profilePath: target, profileTemplatePath: templatePath}) as never);

    await service.onModuleInit();
    const merged = await service.load();

    expect(merged.verified).toMatchObject({
      name: 'Existing Name Must Win', currentSalary: {PKR: {monthly: 0, annual: 0}},
      reasonForLeaving: 'Seeking new opportunities for growth and learning.'
    });
    expect(merged.generatedSuggestions).toEqual([expect.objectContaining({id: 'existing'})]);
  });
});
