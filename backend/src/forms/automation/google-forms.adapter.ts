import {Injectable} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {createHash} from 'node:crypto';
import {Locator, Page} from 'playwright';
import {AppConfiguration} from '../../config/app.config';
import {AnswerValue, FieldType} from '../answering.types';
import {
  ExtractedFormQuestion, FormAction, FormBlocker, FormPageSnapshot, SubmissionEvidence, ValidationResult
} from './form-automation.types';
import {FormPlatformAdapter} from './form-platform-adapter.interface';

interface InspectedControl {
  label: string;
  kind: ExtractedFormQuestion['controlKind'];
  required: boolean;
  options: string[];
  placeholder?: string;
  constraints: ExtractedFormQuestion['constraints'];
}

const QUESTION_SELECTOR = '.Qr7Oae:visible, [data-question]:visible, [role="listitem"]:visible';
const NATIVE_CONTROL_SELECTOR = [
  '.Qr7Oae:visible input', '.Qr7Oae:visible textarea', '.Qr7Oae:visible select',
  '[data-question]:visible input', '[data-question]:visible textarea', '[data-question]:visible select',
  '[role="listitem"]:visible input', '[role="listitem"]:visible textarea', '[role="listitem"]:visible select'
].join(', ');
const LEGAL_DECLARATION = /\b(?:consent|certif(?:y|ication)|declare|declaration|terms|privacy|data processing|background check|truthful|accurate|legally binding|electronic signature|application fee|processing fee|payment|purchase|credit card|bank account|financial commitment)\b/i;

@Injectable()
export class GoogleFormsAdapter implements FormPlatformAdapter {
  readonly platform = 'google_forms';

  constructor(private readonly config: ConfigService<AppConfiguration, true>) {}

  supports(value: string): boolean {
    try {
      const url = new URL(value);
      const host = url.hostname.toLowerCase();
      if (host === 'forms.gle') return url.protocol === 'https:';
      if (host === 'docs.google.com') return url.protocol === 'https:' && url.pathname.startsWith('/forms/');
      return this.config.get('formAllowLocalhost', {infer: true}) &&
        ['127.0.0.1', 'localhost'].includes(host) && ['http:', 'https:'].includes(url.protocol);
    } catch {
      return false;
    }
  }

  async inspect(page: Page, pageIndex: number): Promise<FormPageSnapshot> {
    const containers = page.locator(QUESTION_SELECTOR);
    const count = await containers.count();
    const questions: ExtractedFormQuestion[] = [];
    for (let index = 0; index < count; index += 1) {
      const inspected = await this.inspectControl(containers.nth(index));
      if (!inspected.label && inspected.kind === 'unsupported') continue;
      const label = inspected.label || `Unsupported field ${index + 1}`;
      const id = `gform-p${pageIndex}-q${index}-${createHash('sha1').update(label).digest('hex').slice(0, 8)}`;
      questions.push({
        id,
        label,
        type: this.answerType(inspected.kind),
        controlKind: inspected.kind,
        required: inspected.required,
        options: inspected.options,
        ...(inspected.placeholder ? {placeholder: inspected.placeholder} : {}),
        containerIndex: index,
        pageIndex,
        legalDeclaration: LEGAL_DECLARATION.test(label),
        constraints: inspected.constraints
      });
    }
    const title = (await page.locator('form [role="heading"], form h1, [data-form-title], h1').first().textContent().catch(() => ''))?.trim() ||
      (await page.title());
    return {title, pageIndex, questions, signature: await this.signature(page)};
  }

  async detectBlocker(page: Page): Promise<FormBlocker | null> {
    const url = page.url();
    if (/accounts\.google\.com|\/(?:signin|login|sso|auth)(?:\/|\?|$)/i.test(url)) {
      return {code: 'authentication_required', message: 'The form requires Google authentication.'};
    }
    if (await page.locator('input[type="password"]:visible').count()) {
      return {code: 'authentication_required', message: 'The form redirected to an authentication page.'};
    }
    if (await page.locator('iframe[src*="recaptcha"], .g-recaptcha, [data-sitekey], iframe[src*="hcaptcha"], iframe[src*="turnstile"]').count()) {
      return {code: 'captcha', message: 'The form contains a CAPTCHA that cannot be bypassed.'};
    }
    const body = ((await page.locator('body').innerText().catch(() => '')) || '').slice(0, 20000);
    if (/\b(?:sign in to continue|you need permission|must be signed in|requires sign[ -]?in)\b/i.test(body)) {
      return {code: 'authentication_required', message: 'The form requires authentication or account permission.'};
    }
    if (/\b(?:form is no longer accepting responses|not currently accepting responses|form has been closed)\b/i.test(body)) {
      return {code: 'form_closed', message: 'The form is no longer accepting responses.'};
    }
    if (/\b(?:access denied|request access|you do not have permission)\b/i.test(body)) {
      return {code: 'access_denied', message: 'The form is not accessible to this browser session.'};
    }
    return null;
  }

  async fill(page: Page, question: ExtractedFormQuestion, value: AnswerValue | string): Promise<void> {
    const container = this.container(page, question.containerIndex);
    const text = Array.isArray(value) ? value.join(', ') : String(value);
    switch (question.controlKind) {
      case 'text':
      case 'number':
      case 'date':
        await container.locator('input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]):not([type="file"])').first().fill(text);
        return;
      case 'long_text':
        await container.locator('textarea').first().fill(text);
        return;
      case 'radio':
        await this.chooseOptions(container, [text], false);
        return;
      case 'checkbox':
        await this.chooseOptions(container, Array.isArray(value) ? value.map(String) : [text], true);
        return;
      case 'select':
        await this.chooseSelect(page, container, text);
        return;
      case 'file':
        await this.attachFile(page, container, text);
        return;
      default:
        throw new Error(`Unsupported form control for “${question.label}”.`);
    }
  }

  async verifyFileAttachment(
    page: Page, question: ExtractedFormQuestion, expectedFileName: string, timeoutMs: number
  ): Promise<boolean> {
    const selector = '.Qr7Oae, [data-question], [role="listitem"]';
    try {
      await page.waitForFunction(({selector, index, expected}) => {
        const visible = [...document.querySelectorAll(selector)].filter(element => element.getClientRects().length > 0);
        const container = visible[index];
        if (!container) return false;
        const file = (container.querySelector('input[type="file"]') as HTMLInputElement | null)?.files?.[0]?.name;
        const text = (container.textContent || '').replace(/\s+/g, ' ');
        const uploading = Boolean(container.querySelector('[role="progressbar"], [aria-busy="true"]'));
        return !uploading && (file === expected || text.includes(expected));
      }, {selector, index: question.containerIndex, expected: expectedFileName}, {timeout: timeoutMs});
      return true;
    } catch {
      for (const frame of page.frames()) {
        const input = frame.locator('input[type="file"]').first();
        if (await input.count()) {
          const name = await input.evaluate(node => (node as HTMLInputElement).files?.[0]?.name || '').catch(() => '');
          if (name === expectedFileName) return true;
        }
      }
      return false;
    }
  }

  async validate(page: Page, questions: ExtractedFormQuestion[]): Promise<ValidationResult> {
    const issues: ValidationResult['issues'] = [];
    for (const question of questions.filter(item => item.required)) {
      const answered = await this.isAnswered(this.container(page, question.containerIndex), question.controlKind);
      if (!answered) {
        issues.push({
          questionId: question.id, label: question.label, code: 'required_field_empty', required: true,
          message: 'A required field is not populated.'
        });
      }
    }
    const visibleErrors = await page.locator('[role="alert"]:visible, [aria-invalid="true"]:visible, .RHiWt:visible').allInnerTexts();
    for (const message of [...new Set(visibleErrors.map(value => value.trim()).filter(Boolean))]) {
      issues.push({code: 'visible_validation_error', message});
    }
    const nativeErrors = await page.locator(NATIVE_CONTROL_SELECTOR)
      .evaluateAll(elements => elements.flatMap(element => {
        const control = element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
        return typeof control.checkValidity === 'function' && !control.checkValidity()
          ? [control.validationMessage || 'A native input constraint is not satisfied.'] : [];
      }));
    for (const message of [...new Set(nativeErrors.map(value => value.trim()).filter(Boolean))]) {
      issues.push({code: 'native_validation_error', message});
    }
    return {valid: issues.length === 0, issues};
  }

  async action(page: Page): Promise<FormAction> {
    const controls = page.locator('form button:visible, form [role="button"]:visible, input[type="submit"]:visible, [data-form-action]:visible');
    const count = await controls.count();
    let next: FormAction | null = null;
    for (let index = 0; index < count; index += 1) {
      const element = controls.nth(index);
      const label = ((await element.getAttribute('aria-label')) || (await element.getAttribute('value')) ||
        (await element.innerText().catch(() => '')) || '').trim();
      if (/^(?:submit|send application|apply)$/i.test(label)) return {kind: 'submit', label};
      if (/^(?:next|continue)$/i.test(label)) next = {kind: 'next', label};
    }
    return next || {kind: 'none'};
  }

  async clickAction(page: Page, action: FormAction): Promise<void> {
    if (action.kind === 'none') return;
    const exact = new RegExp(`^${this.escapeRegExp(action.label || action.kind)}$`, 'i');
    const candidates = [
      page.getByRole('button', {name: exact}),
      page.locator(`input[type="submit"][value="${this.cssEscape(action.label || '')}"]`),
      page.locator(`[data-form-action="${action.kind}"]`)
    ];
    for (const candidate of candidates) {
      if (await candidate.first().isVisible().catch(() => false)) {
        await candidate.first().click();
        return;
      }
    }
    throw new Error(`Could not locate the ${action.kind} control.`);
  }

  async waitForNextPage(page: Page, previousSignature: string, timeoutMs: number): Promise<void> {
    await page.waitForFunction(({selector, signature}) => {
      const elements = [...document.querySelectorAll(selector)].filter(element => element.getClientRects().length > 0);
      const current = elements.map(element => (element.textContent || '').replace(/\s+/g, ' ').trim()).join('|');
      return current && current !== signature;
    }, {selector: '.Qr7Oae, [data-question], [role="listitem"]', signature: previousSignature}, {timeout: timeoutMs});
  }

  async detectSubmissionSuccess(page: Page, timeoutMs: number): Promise<SubmissionEvidence | null> {
    const selector = '[data-submission-success]:visible, .freebirdFormviewerViewResponseConfirmationMessage:visible';
    const textPattern = /(?:your response has been recorded|response submitted|application (?:was )?submitted|thank you for (?:applying|your response))/i;
    try {
      await page.waitForFunction(({selector, source}) => {
        const pattern = new RegExp(source, 'i');
        const marked = [...document.querySelectorAll(selector)].find(element => {
          const style = getComputedStyle(element);
          return style.display !== 'none' && style.visibility !== 'hidden';
        });
        return Boolean(marked || pattern.test(document.body?.innerText || ''));
      }, {selector: '[data-submission-success], .freebirdFormviewerViewResponseConfirmationMessage', source: textPattern.source}, {timeout: timeoutMs});
    } catch {
      return null;
    }
    const marked = page.locator(selector).first();
    if (await marked.isVisible().catch(() => false)) {
      const message = ((await marked.innerText().catch(() => '')) || '').trim();
      return {kind: 'confirmation_container', message: message || 'A submission confirmation container was displayed.', url: page.url()};
    }
    const body = await page.locator('body').innerText().catch(() => '');
    const message = body.split('\n').map(value => value.trim()).find(value => textPattern.test(value));
    return message ? {kind: 'confirmation_message', message, url: page.url()} : null;
  }

  private async inspectControl(container: Locator): Promise<InspectedControl> {
    return container.evaluate(element => {
      const visible = (node: Element): boolean => {
        const style = getComputedStyle(node);
        return style.display !== 'none' && style.visibility !== 'hidden';
      };
      const controls = [...element.querySelectorAll('input, textarea, select, [role="radio"], [role="checkbox"], [role="listbox"]')]
        .filter(visible);
      const query = (selector: string) => element.querySelector(selector);
      const input = controls.find(node => node.tagName === 'INPUT') as HTMLInputElement | undefined;
      let kind: InspectedControl['kind'] = 'unsupported';
      if (query('input[type="file"]')) kind = 'file';
      else if (query('textarea')) kind = 'long_text';
      else if (query('input[type="radio"], [role="radio"]')) kind = 'radio';
      else if (query('input[type="checkbox"], [role="checkbox"]')) kind = 'checkbox';
      else if (query('select, [role="listbox"]')) kind = 'select';
      else if (query('input[type="date"]')) kind = 'date';
      else if (query('input[type="number"]')) kind = 'number';
      else if (query('input:not([type="hidden"])')) kind = 'text';

      const heading = query('[data-question-label], .M7eMe, .HoXoMd, legend, [role="heading"], label');
      const rawLabel = heading?.textContent || element.getAttribute('data-label') || '';
      const label = rawLabel.replace(/\s*\*\s*$/, '').replace(/\s+/g, ' ').trim();
      const optionNodes = [...element.querySelectorAll('option, [role="radio"], [role="checkbox"], [role="option"]')]
        .filter(node => !node.closest('[aria-hidden="true"]'));
      const options = optionNodes.map(node => {
        const option = node as HTMLOptionElement;
        const parentText = node.closest('label')?.textContent || node.parentElement?.textContent;
        return (option.label || node.getAttribute('data-value') || node.getAttribute('aria-label') || parentText || node.textContent || '')
          .replace(/\s+/g, ' ').trim();
      }).filter((value, index, all) => value && !/^(?:choose|select)(?: an? option)?$/i.test(value) && all.indexOf(value) === index);
      const required = controls.some(node => node.hasAttribute('required') || node.getAttribute('aria-required') === 'true') ||
        Boolean(query('.vnumgf')) || /\*\s*$/.test(rawLabel) || element.getAttribute('data-required') === 'true';
      const constraints = {
        ...(input?.min ? {min: input.min} : {}),
        ...(input?.max ? {max: input.max} : {}),
        ...(input && input.minLength >= 0 ? {minLength: input.minLength} : {}),
        ...(input && input.maxLength >= 0 ? {maxLength: input.maxLength} : {}),
        ...(input?.pattern ? {pattern: input.pattern} : {}),
        ...((query('input[type="file"]') as HTMLInputElement | null)?.accept
          ? {accept: (query('input[type="file"]') as HTMLInputElement).accept} : {})
      };
      return {label, kind, required, options, placeholder: input?.placeholder || undefined, constraints};
    });
  }

  private answerType(kind: ExtractedFormQuestion['controlKind']): FieldType {
    return kind === 'file' || kind === 'unsupported' ? 'text' : kind;
  }

  private container(page: Page, index: number): Locator {
    return page.locator(QUESTION_SELECTOR).nth(index);
  }

  private async chooseOptions(container: Locator, requested: string[], multiple: boolean): Promise<void> {
    const candidates = container.locator(multiple ? 'input[type="checkbox"], [role="checkbox"]' : 'input[type="radio"], [role="radio"]');
    const count = await candidates.count();
    let selected = 0;
    for (let index = 0; index < count; index += 1) {
      const candidate = candidates.nth(index);
      const label = await candidate.evaluate(node =>
        (node.closest('label')?.textContent || node.parentElement?.textContent || node.getAttribute('data-value') ||
          node.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim());
      if (!requested.some(value => this.normalize(value) === this.normalize(label))) continue;
      const checked = await candidate.isChecked().catch(async () => (await candidate.getAttribute('aria-checked')) === 'true');
      if (!checked) await candidate.click();
      selected += 1;
      if (!multiple) break;
    }
    if (!selected) throw new Error(`No selectable option matched “${requested.join(', ')}”.`);
  }

  private async chooseSelect(page: Page, container: Locator, value: string): Promise<void> {
    const native = container.locator('select').first();
    if (await native.count()) {
      await native.selectOption({label: value});
      return;
    }
    const listbox = container.locator('[role="listbox"]').first();
    await listbox.click();
    const option = page.getByRole('option', {name: new RegExp(`^${this.escapeRegExp(value)}$`, 'i')}).first();
    await option.click();
  }

  private async attachFile(page: Page, container: Locator, path: string): Promise<void> {
    const direct = container.locator('input[type="file"]').first();
    if (await direct.count()) {
      await direct.setInputFiles(path);
      return;
    }
    const openPicker = container.getByRole('button', {name: /upload|add file|browse|choose file/i}).first();
    if (await openPicker.isVisible().catch(() => false)) await openPicker.click();
    const deadline = Date.now() + this.config.get('formNavigationTimeoutMs', {infer: true});
    while (Date.now() < deadline) {
      for (const frame of page.frames()) {
        const input = frame.locator('input[type="file"]').first();
        if (await input.count()) {
          await input.setInputFiles(path);
          return;
        }
      }
      await page.waitForTimeout(200);
    }
    throw new Error('The file picker did not expose an upload control.');
  }

  private async isAnswered(container: Locator, kind: ExtractedFormQuestion['controlKind']): Promise<boolean> {
    if (kind === 'radio' || kind === 'checkbox') {
      const selected = container.locator('input:checked, [aria-checked="true"]');
      return (await selected.count()) > 0;
    }
    if (kind === 'select') {
      const native = container.locator('select').first();
      if (await native.count()) return Boolean(await native.inputValue());
      const value = await container.locator('[role="listbox"]').first().innerText().catch(() => '');
      return Boolean(value.trim() && !/^(?:choose|select)(?: an? option)?$/i.test(value.trim()));
    }
    if (kind === 'file') return (await container.locator('input[type="file"]').first().evaluate(node => (node as HTMLInputElement).files?.length || 0)) > 0;
    if (kind === 'long_text') return Boolean((await container.locator('textarea').first().inputValue()).trim());
    if (kind === 'unsupported') return false;
    return Boolean((await container.locator('input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]):not([type="file"])').first().inputValue()).trim());
  }

  private async signature(page: Page): Promise<string> {
    const texts = await page.locator(QUESTION_SELECTOR).allInnerTexts();
    return texts.map(value => value.replace(/\s+/g, ' ').trim()).join('|');
  }

  private normalize(value: string): string {
    return value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  }

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private cssEscape(value: string): string {
    return value.replace(/["\\]/g, '\\$&');
  }
}
