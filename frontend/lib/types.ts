export type WorkflowStatus = 'pending' | 'processing' | 'completed' | 'needs_manual_action' | 'failed' | 'submission_unknown';

export interface Workflow {
  id: string; applicationId: string; type: 'email' | 'form'; status: WorkflowStatus; stage: string;
  attempts: number; response: unknown; error: string | null; outcome: string; createdAt: string;
  updatedAt: string; completedAt: string | null;
}

export interface FormQuestion {
  workflowId: string; questionId: string; pageIndex: number | null; label: string; fieldType: string | null;
  required: boolean | null; answer: unknown; answerSource: string | null; confidence: string | null;
  outcome: string; errorCode: string | null; errorMessage: string | null; updatedAt: string;
}

export interface WorkflowAttempt {
  id: number; workflowId: string; attemptNumber: number; idempotencyKey: string; status: string; stage: string;
  request: unknown; response: unknown; error: string | null; transient: boolean; startedAt: string;
  completedAt: string | null; durationMs: number | null;
}

export interface ProcessingEvent {
  id: number; batchId: string | null; applicationId: string | null; workflowId: string | null;
  stage: string; status: string; message: string | null; data: unknown; createdAt: string;
}

export interface Application {
  id: string; sourceUrl: string | null; contentHash: string; method: string; payload: unknown; emails: string[];
  formUrls: string[]; company: string | null; role: string | null; location: string | null;
  jobDescription: string; linkedinPostUrl: string | null; applicationUrl: string | null;
  selectedResume: string | null; applicationChannel: string; createdAt: string; updatedAt: string;
  workflows: Workflow[]; formQuestions: FormQuestion[]; formSubmissionAttempts: Array<Record<string, unknown>>;
  workflowAttempts: WorkflowAttempt[]; processingEvents: ProcessingEvent[];
}

export interface BatchItem {
  id: string; batchId: string; position: number; input: Record<string, unknown>; applicationId: string | null;
  targetWorkflowType: 'email' | 'form' | null; retryOfWorkflowId: string | null; status: string;
  attempts: number; result: unknown; error: string | null; availableAt: string; startedAt: string | null;
  completedAt: string | null; createdAt: string; updatedAt: string;
}

export interface Batch {
  id: string; idempotencyKey: string; status: string; concurrency: number; total: number; queued: number;
  processing: number; completed: number; failed: number; createdAt: string; updatedAt: string;
  completedAt: string | null; items: BatchItem[]; duplicate?: boolean; retryAfterMs?: number;
}

export interface Paginated<T> {items: T[]; page: number; pageSize: number; total: number; pages: number}

export interface DashboardData {
  totals: {applications: number; submitted: number; gmailDrafts: number; processing: number; failed: number;
    needsManualAction: number; submissionUnknown: number};
  recentApplications: Application[]; recentActivity: ProcessingEvent[];
  batches: {total: number; active: number; completed: number; withErrors: number};
}

export interface JobInput {text: string; url?: string; links: string[]; capturedAt: string; company?: string; role?: string; location?: string}
