export interface FormProcessingInput {
  jobId: string;
  applicationId: string;
  formUrls: string[];
  text: string;
}

export interface FormProcessingResult {
  status: 'completed' | 'needs_manual_action' | 'failed';
  details?: unknown;
}

export interface FormProcessor {
  /**
   * **Summary:** Processes one form-based application and reports whether it completed, failed, or requires human action.
   * **Inputs:** `input` contains the workflow identity, application identity, candidate form URLs, and job-post text.
   * **Returns:** The form-processing result and any platform-specific details.
   */
  process(input: FormProcessingInput): Promise<FormProcessingResult>;
}

export const FORM_PROCESSOR = Symbol('FORM_PROCESSOR');
