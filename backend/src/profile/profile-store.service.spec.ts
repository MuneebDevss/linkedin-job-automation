import {ConfigService} from '@nestjs/config';
import {mkdtemp, readdir, rm} from 'node:fs/promises';
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
});
