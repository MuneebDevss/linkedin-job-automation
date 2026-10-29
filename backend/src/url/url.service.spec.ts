import {ConfigService} from '@nestjs/config';
import {lookup} from 'node:dns/promises';
import {AppConfiguration} from '../config/app.config';
import {UrlService} from './url.service';

jest.mock('node:dns/promises', () => ({lookup: jest.fn()}));

const mockedLookup = lookup as unknown as jest.Mock;

describe('UrlService', () => {
  let service: UrlService;

  beforeEach(() => {
    service = new UrlService(new ConfigService<AppConfiguration, true>({
      urlResolutionTimeoutMs: 5000
    } as AppConfiguration));
    mockedLookup.mockResolvedValue([{address: '142.250.181.238', family: 4}]);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('follows the destination extracted from a LinkedIn interstitial through its final redirect', async () => {
    const shortUrl = 'https://lnkd.in/desZBmGz';
    const editUrl = 'https://docs.google.com/forms/d/form-id/edit';
    const viewUrl = 'https://docs.google.com/forms/d/form-id/viewform?edit_requested=true';
    const fetchMock = jest.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(
        `<a data-tracking-control-name="external_url_click" href="${editUrl}">Continue</a>`,
        {status: 200, headers: {'content-type': 'text/html'}}
      ))
      .mockResolvedValueOnce(new Response(null, {status: 302, headers: {location: viewUrl}}))
      .mockResolvedValueOnce(new Response('Authentication required', {status: 401}));

    await expect(service.normalizeAndResolve([shortUrl])).resolves.toEqual([viewUrl]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([shortUrl, editUrl, viewUrl]);
  });

  it('keeps an unresolved LinkedIn short URL when no approved external destination is present', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<html>No external link</html>', {status: 200}));

    await expect(service.normalizeAndResolve(['https://lnkd.in/unresolved'])).resolves.toEqual([
      'https://lnkd.in/unresolved'
    ]);
  });
});
