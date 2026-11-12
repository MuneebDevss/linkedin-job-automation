export interface FormProcessingInput {
  jobId: string;
  applicationId: string;
  formUrls: string[];
  text: string;
}

export interface FormProcessingResult {
  status: 'completed' | 'needs_manual_action' | 'failed' | 'submission_unknown';
  details?: unknown;
}

export type FormProcessingStage =
  'processing' | 'generating_answers' | 'filling_form' | 'uploading_resume' |
  'submitting_form' | 'verifying_submission';

export type FormProgressReporter = (stage: FormProcessingStage, message?: string, data?: unknown) => void;

export interface FormProcessor {
  /**
   * **Summary:** Processes one form-based application and reports whether it completed, failed, or requires human action.
   * **Inputs:** `input` contains the workflow identity, application identity, candidate form URLs, and job-post text.
   * **Returns:** The form-processing result and any platform-specific details, including an explicit uncertain-submission state.
   */
  process(input: FormProcessingInput, report?: FormProgressReporter): Promise<FormProcessingResult>;
}

export const FORM_PROCESSOR = Symbol('FORM_PROCESSOR');
