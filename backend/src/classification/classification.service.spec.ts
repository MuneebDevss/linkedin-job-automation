import {ClassificationService} from './classification.service';

describe('ClassificationService', () => {
  const service = new ClassificationService();

  it.each([
    ['email', 'Send your CV to jobs@example.com', []],
    ['form', 'Apply using the form', ['https://forms.gle/example']],
    ['email_and_form', 'Email jobs@example.com or use the form', ['https://evahires.com/jobs/private/11']],
    ['needs_review', 'Message us for more information', []]
  ])('classifies %s applications', (method, text, links) => {
    expect(service.classify(text, links).method).toBe(method);
  });

  it('normalizes and deduplicates email addresses', () => {
    expect(service.classify('Apply at JOBS@example.com or jobs@example.com', []).emails).toEqual(['jobs@example.com']);
  });
});
