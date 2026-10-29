import {Injectable} from '@nestjs/common';

export type ApplicationMethod = 'email' | 'form' | 'email_and_form' | 'needs_review';

export interface Classification {
  method: ApplicationMethod;
  emails: string[];
  formUrls: string[];
}

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/gi;
const FORM_RE = /forms\.gle|docs\.google\.com\/forms|forms\.office\.com|typeform\.com|tally\.so|airtable\.com\/shr|jotform|greenhouse\.io|lever\.co|ashbyhq\.com|evahires\.com\/jobs|workable\.com|smartrecruiters|bamboohr|breezy\.hr|recruitee|zohorecruit|jazzhr|myworkdayjobs|workday|\/apply\b|\/application\b/i;

@Injectable()
export class ClassificationService {
  /**
   * **Summary:** Classifies a job post by the application channels it offers and collects the usable email and form destinations.
   * **Inputs:** `text` is the job-post content; `links` contains URLs discovered in that post.
   * **Returns:** The selected application method together with unique email addresses and form URLs.
   */
  classify(text: string, links: string[]): Classification {
    const deobfuscated = text.normalize('NFKC')
      .replace(/\s*[\[(<{]\s*at\s*[\])>}]\s*/gi, '@')
      .replace(/\s*[\[(<{]\s*dot\s*[\])>}]\s*/gi, '.');
    const emails = [...new Set([
      ...(deobfuscated.match(EMAIL_RE) || []).map(email => email.toLowerCase()),
      ...links.filter(link => /^mailto:/i.test(link)).map(link => link.slice(7).split('?')[0].toLowerCase())
    ])];
    const formUrls = links.filter(link => !link.startsWith('mailto:') && FORM_RE.test(link));
    const method: ApplicationMethod = emails.length && formUrls.length
      ? 'email_and_form'
      : emails.length ? 'email' : formUrls.length ? 'form' : 'needs_review';
    return {method, emails, formUrls};
  }
}
