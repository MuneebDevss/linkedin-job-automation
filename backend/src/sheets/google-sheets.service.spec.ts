import {ConfigService} from '@nestjs/config';
import {AppConfiguration} from '../config/app.config';
import {GoogleSheetsService} from './google-sheets.service';

describe('GoogleSheetsService legacy importer', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('reads legacy rows without issuing any write request', async () => {
    const fetchMock = jest.fn().mockResolvedValue(response({
      values: [
        ['Company', 'Role', 'Job Link', 'Application URL', 'Application Channel', 'Status', 'Location', 'Notes', 'Date Found'],
        ['Acme', 'Developer', 'https://linkedin.test/post/1', 'https://forms.test/apply', 'Form', 'Applied',
          'Islamabad', 'Imported once', '2026-10-29']
      ]
    }));
    global.fetch = fetchMock as typeof fetch;
    const service = new GoogleSheetsService(config());

    await expect(service.readLegacyApplications()).resolves.toEqual([
      expect.objectContaining({company: 'Acme', role: 'Developer', status: 'Applied'})
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]).toEqual(expect.objectContaining({
      headers: {Authorization: 'Bearer test-token'}
    }));
    expect(fetchMock.mock.calls[0][1]).not.toHaveProperty('method');
    expect(fetchMock.mock.calls[0][1]).not.toHaveProperty('body');
  });

  function config(): ConfigService<AppConfiguration, true> {
    return new ConfigService<AppConfiguration, true>({
      googleSheetsSpreadsheetId: 'sheet-id',
      googleSheetsTab: 'Applications',
      googleSheetsCredentialPath: '',
      googleSheetsAccessToken: 'test-token',
      googleSheetsTimeoutMs: 1000
    } as AppConfiguration);
  }

  function response(body: unknown): Response {
    return {ok: true, status: 200, text: async () => JSON.stringify(body)} as Response;
  }
});
