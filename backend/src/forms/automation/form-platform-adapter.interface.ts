import {Page} from 'playwright';
import {AnswerValue} from '../answering.types';
import {
  ExtractedFormQuestion, FormAction, FormBlocker, FormPageSnapshot, SubmissionEvidence, ValidationResult
} from './form-automation.types';

export interface FormPlatformAdapter {
  readonly platform: string;
  /**
   * **Summary:** Determines whether this adapter can safely process a form destination.
   * **Inputs:** `url` is the candidate application-form URL.
   * **Returns:** `true` when the platform is supported, otherwise `false`.
   */
  supports(url: string): boolean;
  /**
   * **Summary:** Describes the current form page and its answerable questions.
   * **Inputs:** `page` is the active form page; `pageIndex` identifies its place in a multi-page form.
   * **Returns:** The normalized page snapshot used by the form processor.
   */
  inspect(page: Page, pageIndex: number): Promise<FormPageSnapshot>;
  /**
   * **Summary:** Detects platform conditions that prevent safe automatic processing.
   * **Inputs:** `page` is the current form or redirect page.
   * **Returns:** The classified blocker, or `null` when processing may continue.
   */
  detectBlocker(page: Page): Promise<FormBlocker | null>;
  /**
   * **Summary:** Enters an approved answer into one discovered form question.
   * **Inputs:** `page` hosts the form; `question` identifies the control; `value` is the answer to enter.
   * **Returns:** A promise that resolves when the field is populated.
   */
  fill(page: Page, question: ExtractedFormQuestion, value: AnswerValue | string): Promise<void>;
  /**
   * **Summary:** Confirms that a requested application document is attached and ready.
   * **Inputs:** `page` hosts the form; `question` identifies the upload; `expectedFileName` and `timeoutMs` define the expected result and wait.
   * **Returns:** `true` when attachment is confirmed, otherwise `false`.
   */
  verifyFileAttachment(page: Page, question: ExtractedFormQuestion, expectedFileName: string, timeoutMs: number): Promise<boolean>;
  /**
   * **Summary:** Checks the populated page for required-field and platform validation issues.
   * **Inputs:** `page` is the current form; `questions` contains its discovered fields.
   * **Returns:** The page validity and actionable issues.
   */
  validate(page: Page, questions: ExtractedFormQuestion[]): Promise<ValidationResult>;
  /**
   * **Summary:** Identifies the next supported navigation or submission action on the form.
   * **Inputs:** `page` is the current form page.
   * **Returns:** The recognized action and its label.
   */
  action(page: Page): Promise<FormAction>;
  /**
   * **Summary:** Activates a previously identified form action.
   * **Inputs:** `page` hosts the form; `action` identifies the control to activate.
   * **Returns:** A promise that resolves after activation.
   */
  clickAction(page: Page, action: FormAction): Promise<void>;
  /**
   * **Summary:** Waits until a multi-page form presents a different set of questions.
   * **Inputs:** `page` is active; `previousSignature` identifies the old page; `timeoutMs` limits the wait.
   * **Returns:** A promise that resolves when the next page is visible.
   */
  waitForNextPage(page: Page, previousSignature: string, timeoutMs: number): Promise<void>;
  /**
   * **Summary:** Finds reliable evidence that the form provider accepted the final submission.
   * **Inputs:** `page` is the post-submit page; `timeoutMs` limits the confirmation wait.
   * **Returns:** The submission evidence, or `null` when success cannot be confirmed.
   */
  detectSubmissionSuccess(page: Page, timeoutMs: number): Promise<SubmissionEvidence | null>;
}
