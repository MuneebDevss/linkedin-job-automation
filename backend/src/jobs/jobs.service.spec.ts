import {ConfigService} from '@nestjs/config';
import {ClassificationService} from '../classification/classification.service';
import {DatabaseService} from '../database/database.service';
import {IdentityService} from '../identity/identity.service';
import {N8nService} from '../n8n/n8n.service';
import {UrlService} from '../url/url.service';
import {ProcessJobDto} from './dto/process-job.dto';
import {JobsService} from './jobs.service';

describe('JobsService', () => {
  let database: DatabaseService;
  let n8n: {forward: jest.Mock};
  let service: JobsService;
  let forms: {process: jest.Mock};
  const base: ProcessJobDto = {
    text: 'Acme is hiring a developer. Send CV to jobs@acme.test',
    url: 'https://www.linkedin.com/feed/update/urn:li:activity:1234567890123456789/',
    links: [],
    capturedAt: '2026-10-27T12:00:00.000Z'
  };

  beforeEach(() => {
    const config = new ConfigService({databasePath: ':memory:'});
    database = new DatabaseService(config as never);
    database.onModuleInit();
    n8n = {forward: jest.fn().mockResolvedValue({ok: true, status: 'draft_created'})};
    forms = {process: jest.fn().mockResolvedValue({status: 'completed', details: {evidence: 'mock confirmation'}})};
    const urls = {
      extractTextUrls: jest.fn().mockReturnValue([]),
      normalizeAndResolve: jest.fn(async (links: string[]) => [...new Set(links)]),
      normalize: jest.fn((value: string) => value || null)
    };
    service = new JobsService(
      urls as unknown as UrlService,
      new ClassificationService(),
      new IdentityService(),
      database,
      n8n as unknown as N8nService,
      forms
    );
  });

  afterEach(() => database.onModuleDestroy());

  it('forwards the unchanged webhook contract for email applications', async () => {
    const result = await service.process(base);
    expect(result.method).toBe('email');
    expect(n8n.forward).toHaveBeenCalledWith({
      text: base.text,
      url: base.url,
      links: [],
      capturedAt: base.capturedAt
    });
    expect(result.workflows.email).toMatchObject({status: 'completed', duplicate: false});
  });

  it('deduplicates email and form workflows independently', async () => {
    await service.process(base);
    const withForm = {...base, links: ['https://forms.gle/example']};
    const firstCombined = await service.process(withForm);
    const duplicateCombined = await service.process(withForm);

    expect(n8n.forward).toHaveBeenCalledTimes(1);
    expect(firstCombined.workflows.email).toMatchObject({duplicate: true, status: 'completed'});
    expect(firstCombined.workflows.form).toMatchObject({duplicate: false, status: 'completed'});
    expect(duplicateCombined.workflows.form).toMatchObject({duplicate: true, status: 'completed'});
  });

  it('persists the form job even when the email workflow fails', async () => {
    n8n.forward.mockRejectedValueOnce(new Error('n8n unavailable'));
    const result = await service.process({...base, links: ['https://forms.gle/example']});
    expect(result.workflows.email).toMatchObject({status: 'failed'});
    expect(result.workflows.form).toMatchObject({status: 'completed', duplicate: false});
    expect(service.get(result.applicationId).workflows).toEqual(expect.arrayContaining([
      expect.objectContaining({type: 'email', status: 'failed'}),
      expect.objectContaining({type: 'form', status: 'completed'})
    ]));
  });

  it('records manual action without blocking the email branch', async () => {
    forms.process.mockResolvedValueOnce({status: 'needs_manual_action', details: {reason: 'captcha'}});
    const result = await service.process({...base, links: ['https://forms.gle/example']});
    expect(result.workflows.email).toMatchObject({status: 'completed'});
    expect(result.workflows.form).toMatchObject({status: 'needs_manual_action'});
  });
});
