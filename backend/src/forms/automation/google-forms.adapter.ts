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
  interactive: boolean;
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

  /**
   * **Summary:** Creates the Google Forms adapter with access to form-automation safety and timing settings.
   * **Inputs:** `config` provides the settings that govern supported local forms and browser behavior.
   * **Returns:** An adapter instance ready to inspect and operate supported forms.
   */
  constructor(private readonly config: ConfigService<AppConfiguration, true>) {}

  /**
   * **Summary:** Determines whether a URL belongs to Google Forms or an explicitly allowed local test form.
   * **Inputs:** `value` is the candidate form URL.
   * **Returns:** `true` when this adapter supports the destination, otherwise `false`.
   */
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

  /**
   * **Summary:** Reads the current form page into a stable question snapshot used for answer generation, filling, and change detection.
   * **Inputs:** `page` is the visible form page; `pageIndex` identifies its position in a multi-page form.
   * **Returns:** The page title, discovered questions, page index, and content signature.
   */
  async inspect(page: Page, pageIndex: number): Promise<FormPageSnapshot> {
    const containers = page.locator(QUESTION_SELECTOR);
    const count = await containers.count();
    const questions: ExtractedFormQuestion[] = [];
    for (let index = 0; index < count; index += 1) {
      const inspected = await this.inspectControl(containers.nth(index));
      if (!inspected.interactive) continue;
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

  /**
   * **Summary:** Detects conditions that require human intervention or make the form unavailable before automation proceeds.
   * **Inputs:** `page` is the current form or redirect page.
   * **Returns:** A classified blocker such as authentication, CAPTCHA, closure, or access denial, or `null` when clear.
   */
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

  /**
   * **Summary:** Populates one form question using the interaction appropriate to its discovered control type.
   * **Inputs:** `page` hosts the form; `question` identifies the control; `value` is the approved answer to enter.
   * **Returns:** A promise that resolves after the field has been populated.
   */
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

  /**
   * **Summary:** Confirms that an uploaded application document is attached and no longer in progress before submission continues.
   * **Inputs:** `page` hosts the form; `question` identifies the upload control; `expectedFileName` and `timeoutMs` define the expected result and wait limit.
   * **Returns:** `true` when the expected file is attached, otherwise `false`.
   */
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

  /**
   * **Summary:** Reviews required fields and browser-reported constraints to prevent advancing with incomplete or invalid answers.
   * **Inputs:** `page` is the populated form page; `questions` contains its discovered field definitions.
   * **Returns:** A validation result containing the overall validity and every actionable issue.
   */
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

  /**
   * **Summary:** Determines whether the current form page can advance, submit, or has no recognized action.
   * **Inputs:** `page` is the current form page.
   * **Returns:** The next available form action and its visible label when applicable.
   */
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

  /**
   * **Summary:** Activates the previously identified next or submit control on the form.
   * **Inputs:** `page` hosts the form; `action` identifies the control and label to activate.
   * **Returns:** A promise that resolves after the action is clicked, or immediately when no action is required.
   */
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

  /**
   * **Summary:** Waits for a multi-page form to replace its current questions after the user-facing next action.
   * **Inputs:** `page` is the active form; `previousSignature` identifies the old page; `timeoutMs` limits the wait.
   * **Returns:** A promise that resolves when a different question page is visible.
   */
  async waitForNextPage(page: Page, previousSignature: string, timeoutMs: number): Promise<void> {
    await page.waitForFunction(({selector, signature}) => {
      const elements = [...document.querySelectorAll(selector)].filter(element => element.getClientRects().length > 0);
      const current = elements.map(element => (element.textContent || '').replace(/\s+/g, ' ').trim()).join('|');
      return current && current !== signature;
    }, {selector: '.Qr7Oae, [data-question], [role="listitem"]', signature: previousSignature}, {timeout: timeoutMs});
  }

  /**
   * **Summary:** Looks for reliable confirmation that the form provider accepted the application submission.
   * **Inputs:** `page` is the post-submission page; `timeoutMs` limits how long confirmation may appear.
   * **Returns:** Submission evidence with its message and URL, or `null` when success cannot be verified.
   */
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

  /**
   * **Summary:** Extracts the business-relevant label, field type, requirements, choices, and constraints from one visible question container.
   * **Inputs:** `container` is the browser element containing one form question.
   * **Returns:** The normalized control description used to build a form question.
   */
  private async inspectControl(container: Locator): Promise<InspectedControl> {
    return container.evaluate(element => {
      /**
       * **Summary:** Determines whether a candidate control is presented to the applicant and should be included in inspection.
       * **Inputs:** `node` is a control found within the question container.
       * **Returns:** `true` when the control is visibly available, otherwise `false`.
       */
      const visible = (node: Element): boolean => {
        const style = getComputedStyle(node);
        return style.display !== 'none' && style.visibility !== 'hidden';
      };
      const controls = [...element.querySelectorAll('input, textarea, select, [role="radio"], [role="checkbox"], [role="listbox"]')]
        .filter(visible);
      /**
       * **Summary:** Finds the first descendant matching a control or metadata selector within the current question.
       * **Inputs:** `selector` describes the descendant to locate.
       * **Returns:** The matching element, or `null` when it is absent.
       */
      const query = (selector: string) => element.querySelector(selector);
      const input = controls.find(node => node.tagName === 'INPUT') as HTMLInputElement | undefined;
      const uploadButton = [...element.querySelectorAll('button, [role="button"]')]
        .filter(visible)
        .find(node => /\b(?:add file|upload|browse|choose file|select files?)\b/i.test(
          `${node.getAttribute('aria-label') || ''} ${node.textContent || ''}`
        ));
      let kind: InspectedControl['kind'] = 'unsupported';
      if (query('input[type="file"]') || uploadButton) kind = 'file';
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
      return {
        label, kind, interactive: controls.length > 0 || Boolean(uploadButton) || Boolean(query('input[type="file"]')), required, options,
        placeholder: input?.placeholder || undefined, constraints
      };
    });
  }

  /**
   * **Summary:** Maps a discovered browser control to the answer type understood by the answer engine.
   * **Inputs:** `kind` is the inspected form-control category.
   * **Returns:** The compatible answer field type.
   */
  private answerType(kind: ExtractedFormQuestion['controlKind']): FieldType {
    return kind === 'file' || kind === 'unsupported' ? 'text' : kind;
  }

  /**
   * **Summary:** Locates a question container by its stable visible order on the current form page.
   * **Inputs:** `page` hosts the form; `index` is the question's visible container position.
   * **Returns:** A locator for the requested question container.
   */
  private container(page: Page, index: number): Locator {
    return page.locator(QUESTION_SELECTOR).nth(index);
  }

  /**
   * **Summary:** Selects the requested radio or checkbox choices while enforcing single- or multi-choice behavior.
   * **Inputs:** `container` holds the question; `requested` lists answer labels; `multiple` permits more than one selection.
   * **Returns:** A promise that resolves after matching options are selected.
   */
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

  /**
   * **Summary:** Chooses a requested value from either a native select field or an accessible listbox.
   * **Inputs:** `page` hosts popup options; `container` holds the question; `value` is the option label to choose.
   * **Returns:** A promise that resolves after the option is selected.
   */
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

  /**
   * **Summary:** Attaches an application document through the form's direct or embedded upload control.
   * **Inputs:** `page` hosts any embedded picker; `container` holds the upload question; `path` identifies the approved document.
   * **Returns:** A promise that resolves after the file has been assigned to an upload control.
   */
  private async attachFile(page: Page, container: Locator, path: string): Promise<void> {
    const direct = container.locator('input[type="file"]').first();
    if (await direct.count()) {
      await direct.setInputFiles(path);
      return;
    }
    const openPicker = container.getByRole('button', {name: /upload|add file|browse|choose file/i}).first();
    if (await openPicker.isVisible().catch(() => false) && await this.setFileFromButton(page, openPicker, path)) return;
    const deadline = Date.now() + this.config.get('formNavigationTimeoutMs', {infer: true});
    while (Date.now() < deadline) {
      for (const frame of page.frames()) {
        const input = frame.locator('input[type="file"]').first();
        if (await input.count()) {
          await input.setInputFiles(path);
          return;
        }
        const browse = frame.getByRole('button', {name: /select files? from (?:your )?device|browse|choose file/i}).first();
        if (await browse.isVisible().catch(() => false) && await this.setFileFromButton(page, browse, path)) return;
      }
      await page.waitForTimeout(200);
    }
    throw new Error('The file picker did not expose an upload control.');
  }

  /**
   * **Summary:** Clicks an upload control while listening for the native chooser that Google exposes only during the click.
   * **Inputs:** `page` receives chooser events; `button` opens the picker; `path` is the approved document.
   * **Returns:** `true` when a chooser accepted the file, otherwise `false` so embedded-picker discovery can continue.
   */
  private async setFileFromButton(page: Page, button: Locator, path: string): Promise<boolean> {
    const chooser = page.waitForEvent('filechooser', {timeout: 2000}).catch(() => null);
    await button.click();
    const event = await chooser;
    if (!event) return false;
    await event.setFiles(path);
    return true;
  }

  /**
   * **Summary:** Checks whether a form question currently contains a meaningful answer for its control type.
   * **Inputs:** `container` holds the question; `kind` identifies how its answer is represented.
   * **Returns:** `true` when the field is answered, otherwise `false`.
   */
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
    if (kind === 'file') {
      const input = container.locator('input[type="file"]').first();
      if (await input.count() && (await input.evaluate(node => (node as HTMLInputElement).files?.length || 0)) > 0) return true;
      const text = await container.innerText().catch(() => '');
      return /\.[a-z0-9]{2,8}\b/i.test(text);
    }
    if (kind === 'long_text') return Boolean((await container.locator('textarea').first().inputValue()).trim());
    if (kind === 'unsupported') return false;
    return Boolean((await container.locator('input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]):not([type="file"])').first().inputValue()).trim());
  }

  /**
   * **Summary:** Builds a stable summary of the current question page for detecting multi-page form transitions.
   * **Inputs:** `page` is the current form page.
   * **Returns:** A normalized signature derived from the visible questions.
   */
  private async signature(page: Page): Promise<string> {
    const texts = await page.locator(QUESTION_SELECTOR).allInnerTexts();
    return texts.map(value => value.replace(/\s+/g, ' ').trim()).join('|');
  }

  /**
   * **Summary:** Normalizes human-written labels so form choices can be matched despite casing, punctuation, or Unicode differences.
   * **Inputs:** `value` is the label or answer text to normalize.
   * **Returns:** The normalized comparison text.
   */
  private normalize(value: string): string {
    return value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  }

  /**
   * **Summary:** Escapes user-facing text for safe use in an exact regular-expression match.
   * **Inputs:** `value` is the literal text to protect.
   * **Returns:** The regular-expression-safe text.
   */
  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * **Summary:** Escapes an option label for safe inclusion in a CSS attribute selector.
   * **Inputs:** `value` is the literal attribute value to protect.
   * **Returns:** The selector-safe attribute text.
   */
  private cssEscape(value: string): string {
    return value.replace(/["\\]/g, '\\$&');
  }
}
