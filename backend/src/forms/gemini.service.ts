import {Injectable, Logger, ServiceUnavailableException} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {AppConfiguration} from '../config/app.config';
import {VerifiedProfile, ResumeProfile} from '../profile/profile.types';
import {AnswerValue, Confidence, FormQuestion, JobAnswerContext} from './answering.types';

export interface GeminiAnswer {
  questionId: string;
  answer: AnswerValue;
  confidence: Confidence;
  reusable: boolean;
  provenance: {reason: string; evidence: string[]};
  model?: string;
}

@Injectable()
export class GeminiService {
  private readonly logger = new Logger(GeminiService.name);

  /**
   * **Summary:** Creates the AI answer service with access to the configured model, credentials, and request limits.
   * **Inputs:** `config` provides Gemini connection and timeout settings.
   * **Returns:** A Gemini service instance ready to answer unresolved questions.
   */
  constructor(private readonly config: ConfigService<AppConfiguration, true>) {}

  /**
   * **Summary:** Requests grounded answers for unresolved application questions using only supplied verified profile, resume, and job context.
   * **Inputs:** `input` contains the job, trusted profile, selected resume, and unresolved questions.
   * **Returns:** Validated typed Gemini answers with confidence, reuse guidance, and provenance.
   */
  async answer(input: {
    job: JobAnswerContext;
    verifiedProfile: VerifiedProfile;
    resume: ResumeProfile | null;
    questions: FormQuestion[];
  }): Promise<GeminiAnswer[]> {
    const apiKey = this.config.get('geminiApiKey', {infer: true});
    if (!apiKey) throw new ServiceUnavailableException('Gemini is not configured.');
    const model = this.config.get('geminiModel', {infer: true});
    if (!/^[a-zA-Z0-9._-]+$/.test(model)) throw new Error('GEMINI_MODEL contains invalid characters.');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.get('geminiTimeoutMs', {infer: true}));
    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: {'content-type': 'application/json', 'x-goog-api-key': apiKey},
        signal: controller.signal,
        body: JSON.stringify({
          systemInstruction: {parts: [{text: this.systemInstruction()}]},
          contents: [{role: 'user', parts: [{text: JSON.stringify(input)}]}],
          generationConfig: {
            temperature: 0.1,
            responseMimeType: 'application/json',
            responseSchema: this.responseSchema()
          }
        })
      });
      const body = await response.json() as Record<string, unknown>;
      if (!response.ok) throw new Error(`Gemini returned HTTP ${response.status}.`);
      const text = this.responseText(body);
      return this.validate(JSON.parse(text), input.questions).map(answer => ({...answer, model}));
    } catch (error) {
      this.logger.warn(`Gemini answer generation failed: ${error instanceof Error ? error.message : String(error)}`);
      throw new ServiceUnavailableException('Gemini answer generation failed.');
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * **Summary:** Defines the safety and grounding rules that prevent the model from inventing application facts.
   * **Inputs:** No parameters.
   * **Returns:** The system instruction supplied to the AI model.
   */
  private systemInstruction(): string {
    return [
      'Answer only the supplied unresolved job-application questions.',
      'Use only the verified profile, selected resume, and job description supplied in the JSON context.',
      'Answer meaningful optional questions as well as required questions when the supplied context supports an accurate answer.',
      'Treat verified work-condition preferences such as onsite work, shifts, relocation, flexible hours, learning, and salary negotiability as authoritative.',
      'Never invent identity, contact, education, qualifications, certifications, employment history, experience, salary, availability, work authorization, relocation, or dates.',
      'Omit any question that cannot be answered reliably. Respect the question field type and listed options exactly.',
      'For each answer, choose one answer.kind and populate only its matching typed value property.',
      'Return JSON matching the schema. Evidence must name the provided context used. Mark reusable only for non-job-specific wording.'
    ].join(' ');
  }

  /**
   * **Summary:** Defines the structured response contract required for safely interpreting AI-generated application answers.
   * **Inputs:** No parameters.
   * **Returns:** The schema describing valid answer records and typed values.
   */
  private responseSchema(): Record<string, unknown> {
    return {
      type: 'OBJECT',
      required: ['answers'],
      properties: {
        answers: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            required: ['questionId', 'answer', 'confidence', 'reusable', 'provenance'],
            properties: {
              questionId: {type: 'STRING'},
              answer: {
                type: 'OBJECT', required: ['kind'],
                properties: {
                  kind: {type: 'STRING', enum: ['string', 'number', 'boolean', 'string_array']},
                  stringValue: {type: 'STRING'},
                  numberValue: {type: 'NUMBER'},
                  booleanValue: {type: 'BOOLEAN'},
                  stringArrayValue: {type: 'ARRAY', items: {type: 'STRING'}}
                }
              },
              confidence: {type: 'STRING', enum: ['high', 'medium', 'low']},
              reusable: {type: 'BOOLEAN'},
              provenance: {
                type: 'OBJECT', required: ['reason', 'evidence'],
                properties: {reason: {type: 'STRING'}, evidence: {type: 'ARRAY', items: {type: 'STRING'}}}
              }
            }
          }
        }
      }
    };
  }

  /**
   * **Summary:** Extracts the model's structured answer payload from a successful Gemini API response.
   * **Inputs:** `body` is the untrusted response returned by Gemini.
   * **Returns:** The JSON answer text without optional Markdown wrapping.
   */
  private responseText(body: Record<string, unknown>): string {
    const candidates = body.candidates as Array<{content?: {parts?: Array<{text?: string}>}}> | undefined;
    const text = candidates?.[0]?.content?.parts?.map(part => part.text || '').join('').trim();
    if (!text) throw new Error('Gemini returned no structured content.');
    return text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  }

  /**
   * **Summary:** Validates AI answer records against requested question IDs, uniqueness, confidence, reuse, and provenance requirements.
   * **Inputs:** `value` is the parsed model response; `questions` defines the allowed targets.
   * **Returns:** The validated Gemini answers with normalized typed values.
   */
  private validate(value: unknown, questions: FormQuestion[]): GeminiAnswer[] {
    const raw = value as {answers?: unknown[]};
    if (!raw || !Array.isArray(raw.answers)) throw new Error('Gemini response is missing answers.');
    const allowed = new Set(questions.map(question => question.id));
    const seen = new Set<string>();
    const answers: GeminiAnswer[] = [];
    for (const item of raw.answers) {
      try {
        const answer = item as Partial<GeminiAnswer> & {answer?: unknown};
        if (!answer || typeof answer.questionId !== 'string' || !allowed.has(answer.questionId) || seen.has(answer.questionId) ||
          !['high', 'medium', 'low'].includes(String(answer.confidence)) || typeof answer.reusable !== 'boolean' ||
          !answer.provenance || typeof answer.provenance.reason !== 'string' || !Array.isArray(answer.provenance.evidence)) {
          throw new Error('invalid answer metadata');
        }
        const typed = this.typedValue(answer.answer);
        seen.add(answer.questionId);
        answers.push({...answer, answer: typed} as GeminiAnswer);
      } catch (error) {
        this.logger.warn(`Ignoring one invalid Gemini answer: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return answers;
  }

  /**
   * **Summary:** Converts the model's discriminated value object into the answer type used by the application.
   * **Inputs:** `value` is the untrusted typed-value object returned by Gemini.
   * **Returns:** A validated string, number, boolean, or string-list answer.
   */
  private typedValue(value: unknown): AnswerValue {
    const typed = value as {
      kind?: string; stringValue?: unknown; numberValue?: unknown;
      booleanValue?: unknown; stringArrayValue?: unknown;
    };
    if (typed?.kind === 'string' && typeof typed.stringValue === 'string') return typed.stringValue;
    if (typed?.kind === 'number' && typeof typed.numberValue === 'number' && Number.isFinite(typed.numberValue)) return typed.numberValue;
    if (typed?.kind === 'boolean' && typeof typed.booleanValue === 'boolean') return typed.booleanValue;
    if (typed?.kind === 'string_array' && Array.isArray(typed.stringArrayValue) &&
      typed.stringArrayValue.every(item => typeof item === 'string')) return typed.stringArrayValue as string[];
    throw new Error('Gemini answer value does not match its declared type.');
  }
}
