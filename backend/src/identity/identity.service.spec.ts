import {IdentityService} from './identity.service';

describe('IdentityService', () => {
  const service = new IdentityService();

  it('uses the LinkedIn activity URN when present', () => {
    expect(service.create(
      'https://www.linkedin.com/feed/update/urn:li:activity:1234567890123456789/',
      'Job post', []
    ).applicationId).toBe('linkedin:activity:1234567890123456789');
  });

  it('uses a canonical content fallback without a stable permalink', () => {
    const first = service.create('https://www.linkedin.com/my-items/saved-posts/', 'We are HIRING! #Jobs', []);
    const second = service.create(null, '  we are hiring  ', []);
    expect(first.applicationId).toBe(second.applicationId);
    expect(first.applicationId).toMatch(/^content:[a-f0-9]{64}$/);
  });
});
