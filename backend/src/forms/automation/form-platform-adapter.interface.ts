import {Page} from 'playwright';
import {AnswerValue} from '../answering.types';
import {
  ExtractedFormQuestion, FormAction, FormBlocker, FormPageSnapshot, SubmissionEvidence, ValidationResult
} from './form-automation.types';

export interface FormPlatformAdapter {
  readonly platform: string;
  supports(url: string): boolean;
  inspect(page: Page, pageIndex: number): Promise<FormPageSnapshot>;
  detectBlocker(page: Page): Promise<FormBlocker | null>;
  fill(page: Page, question: ExtractedFormQuestion, value: AnswerValue | string): Promise<void>;
  verifyFileAttachment(page: Page, question: ExtractedFormQuestion, expectedFileName: string, timeoutMs: number): Promise<boolean>;
  validate(page: Page, questions: ExtractedFormQuestion[]): Promise<ValidationResult>;
  action(page: Page): Promise<FormAction>;
  clickAction(page: Page, action: FormAction): Promise<void>;
  waitForNextPage(page: Page, previousSignature: string, timeoutMs: number): Promise<void>;
  detectSubmissionSuccess(page: Page, timeoutMs: number): Promise<SubmissionEvidence | null>;
}
