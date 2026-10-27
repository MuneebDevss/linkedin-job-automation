import {BadRequestException, Injectable, Logger} from '@nestjs/common';
import {createHash} from 'node:crypto';
import {ProfileStoreService} from '../profile/profile-store.service';
import {ProfileDocument, ReusableAnswer} from '../profile/profile.types';
import {
  AnswerConflict, AnswerSource, AnswerValue, Confidence, FormQuestion, GeneratedAnswer,
  JobAnswerContext, SalaryPeriod, Seniority
} from './answering.types';
import {GeminiAnswer, GeminiService} from './gemini.service';
import {QuestionMatch, QuestionMatcherService} from './question-matcher.service';
import {ResumeSelectorService} from './resume-selector.service';

interface Candidate {
  value: AnswerValue;
  source: AnswerSource;
  confidence: Confidence;
  detail: string;
  profileField?: string;
  suggestionId?: string;
}

@Injectable()
export class AnswerEngineService {
  private readonly logger = new Logger(AnswerEngineService.name);

  constructor(
    private readonly profiles: ProfileStoreService,
    private readonly matcher: QuestionMatcherService,
    private readonly resumes: ResumeSelectorService,
    private readonly gemini: GeminiService
  ) {}

  async generate(input: {job: JobAnswerContext; questions: FormQuestion[]}) {
    if (new Set(input.questions.map(question => question.id)).size !== input.questions.length) {
      throw new BadRequestException('Question IDs must be unique.');
    }
    const profile = await this.profiles.load();
    const resumeSelection = this.resumes.select(input.job, profile.resumeCatalog);
    const answers = new Map<string, GeneratedAnswer>();
    const conflicts: AnswerConflict[] = [];
    const pending: Array<{question: FormQuestion; match: QuestionMatch | null}> = [];

    for (const question of input.questions) {
      const match = this.matcher.match(question);
      const suggestion = this.findSuggestion(profile, question, match, input.job);
      const verified = match ? this.verifiedCandidate(profile, question, match, input.job) : null;
      if (verified) {
        if (suggestion && !this.equalValues(verified.value, suggestion.value)) {
          conflicts.push({
            questionId: question.id,
            keptSource: 'verified_profile',
            ignoredSuggestionId: suggestion.suggestionId!,
            reason: 'Verified profile data has priority over the conflicting reusable answer.'
          });
        }
        answers.set(question.id, this.toAnswer(question, match, verified));
        continue;
      }
      if (suggestion) {
        answers.set(question.id, this.toAnswer(question, match, suggestion));
        continue;
      }
      const derived = match ? this.derivedCandidate(profile, question, match, input.job) : null;
      if (derived) {
        answers.set(question.id, this.toAnswer(question, match, derived));
        continue;
      }
      pending.push({question, match});
    }

    if (pending.length) {
      try {
        const generated = await this.gemini.answer({
          job: input.job,
          verifiedProfile: profile.verified,
          resume: resumeSelection.resume,
          questions: pending.map(item => item.question)
        });
        const byId = new Map(generated.map(item => [item.questionId, item]));
        const suggestions: ReusableAnswer[] = [];
        for (const item of pending) {
          const generatedAnswer = byId.get(item.question.id);
          const accepted = generatedAnswer ? this.acceptGemini(item.question, item.match, generatedAnswer) : null;
          if (accepted) {
            answers.set(item.question.id, accepted);
            if (generatedAnswer?.reusable && generatedAnswer.confidence !== 'low') {
              suggestions.push(this.toSuggestion(item.question, item.match, generatedAnswer, input.job));
            }
          }
        }
        await this.profiles.addGeneratedSuggestions(suggestions);
      } catch (error) {
        this.logger.warn(`Falling back to unresolved answers: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    for (const {question, match} of pending) {
      if (!answers.has(question.id)) {
        answers.set(question.id, {
          questionId: question.id,
          question: question.label,
          fieldType: question.type,
          value: null,
          confidence: 'low',
          ...(match ? {matchedField: match.fieldKey} : {}),
          provenance: {source: 'unresolved', detail: 'No reliable profile, approved, derived, or Gemini answer was available.'}
        });
      }
    }

    return {
      answers: input.questions.map(question => answers.get(question.id)!),
      resume: resumeSelection,
      conflicts,
      priority: ['verified_profile', 'approved_suggestion', 'deterministic', 'gemini', 'unresolved']
    };
  }

  private verifiedCandidate(
    profile: ProfileDocument, question: FormQuestion, match: QuestionMatch, job: JobAnswerContext
  ): Candidate | null {
    if (match.fieldKey === 'salary') return this.salaryCandidate(profile, question, job, false);
    const values: Record<string, unknown> = {
      name: profile.verified.name,
      email: profile.verified.email,
      phone: profile.verified.phone,
      linkedin: profile.verified.linkedin,
      github: profile.verified.github,
      location: profile.verified.location,
      university: profile.verified.university,
      cgpa: profile.verified.cgpa,
      employmentStatus: profile.verified.employmentStatus,
      workAuthorization: profile.verified.workAuthorization,
      yearsOfExperience: profile.verified.yearsOfExperience,
      strengths: profile.verified.strengths,
      relocation: profile.verified.relocation.willing,
      availability: question.type === 'date'
        ? profile.verified.availability.date
        : profile.verified.availability.status || profile.verified.availability.date
    };
    const value = this.adapt(question, values[match.fieldKey]);
    if (value === null) return null;
    return {
      value, source: 'verified_profile', confidence: match.confidence >= 0.9 ? 'high' : 'medium',
      detail: `Matched verified profile field ${match.fieldKey}.`, profileField: match.fieldKey
    };
  }

  private derivedCandidate(
    profile: ProfileDocument, question: FormQuestion, match: QuestionMatch, job: JobAnswerContext
  ): Candidate | null {
    let raw: unknown = null;
    let detail = '';
    if (match.fieldKey === 'firstName' || match.fieldKey === 'lastName') {
      const parts = profile.verified.name.trim().split(/\s+/);
      raw = match.fieldKey === 'firstName' ? parts[0] : parts.slice(1).join(' ');
      detail = `Derived ${match.fieldKey} from the verified full name.`;
    } else if (match.fieldKey === 'salary') {
      return this.salaryCandidate(profile, question, job, true);
    } else if (match.fieldKey === 'strengths' && profile.verified.strengths.length) {
      raw = question.type === 'checkbox' ? profile.verified.strengths : profile.verified.strengths.join(', ');
      detail = 'Formatted verified strengths for the requested field type.';
    }
    const value = this.adapt(question, raw);
    return value === null ? null : {value, source: 'deterministic', confidence: 'high', detail};
  }

  private salaryCandidate(
    profile: ProfileDocument, question: FormQuestion, job: JobAnswerContext, allowConversion: boolean
  ): Candidate | null {
    const seniority = this.jobSeniority(job);
    const salaryText = this.salaryQuestionText(question);
    const currency = (question.currency || this.detectCurrency(salaryText) || job.currency)?.toUpperCase();
    const period = question.salaryPeriod || this.detectSalaryPeriod(salaryText);
    if (!seniority || !currency || !period) return null;
    const band = profile.verified.salaryExpectations[seniority]?.[currency];
    if (!band) return null;
    let amount = band[period];
    let source: AnswerSource = 'verified_profile';
    let detail = `Used verified ${seniority} ${currency} ${period} salary expectation.`;
    if (amount === null && allowConversion) {
      if (period === 'annual' && band.monthly !== null) {
        amount = band.monthly * 12;
        source = 'deterministic';
        detail = `Derived annual ${currency} salary as 12 × the verified monthly amount.`;
      } else if (period === 'monthly' && band.annual !== null) {
        amount = band.annual / 12;
        source = 'deterministic';
        detail = `Derived monthly ${currency} salary as the verified annual amount ÷ 12.`;
      }
    }
    if (amount === null) return null;
    const raw: unknown = question.type === 'number' ? amount
      : question.type === 'radio' || question.type === 'select' ? amount
        : `${currency} ${amount} per ${period === 'annual' ? 'year' : 'month'}`;
    const value = this.adapt(question, raw);
    return value === null ? null : {
      value, source, confidence: 'high', detail,
      profileField: `salaryExpectations.${seniority}.${currency}.${period}`
    };
  }

  private findSuggestion(
    profile: ProfileDocument, question: FormQuestion, match: QuestionMatch | null, job: JobAnswerContext
  ): Candidate | null {
    const normalized = this.matcher.normalize(question.label);
    const seniority = this.jobSeniority(job);
    const salaryText = this.salaryQuestionText(question);
    const currency = (question.currency || this.detectCurrency(salaryText) || job.currency)?.toUpperCase();
    const period = question.salaryPeriod || this.detectSalaryPeriod(salaryText);
    const compatible = profile.approvedReusableAnswers
      .filter(item => item.approved && item.fieldType === question.type && item.confidence !== 'low')
      .filter(item => item.normalizedQuestion === normalized || Boolean(match && item.fieldKey === match.fieldKey))
      .filter(item => this.compatible(item, job, seniority, currency, period))
      .sort((a, b) => (a.confidence === 'high' ? -1 : 1) - (b.confidence === 'high' ? -1 : 1));
    const item = compatible[0];
    if (!item) return null;
    const value = this.adapt(question, item.answer);
    return value === null ? null : {
      value, source: 'approved_suggestion', confidence: item.confidence,
      detail: 'Reused an approved compatible answer.', suggestionId: item.id
    };
  }

  private compatible(
    item: ReusableAnswer, job: JobAnswerContext, seniority: Seniority | null,
    currency: string | undefined, period: SalaryPeriod | null
  ): boolean {
    const rules = item.compatibility;
    if (!rules) return true;
    if (rules.roles?.length && !rules.roles.some(role =>
      this.matcher.normalize(`${job.title || ''} ${job.description}`).includes(this.matcher.normalize(role)))) return false;
    if (rules.seniorities?.length && (!seniority || !rules.seniorities.includes(seniority))) return false;
    if (rules.currencies?.length && (!currency || !rules.currencies.map(value => value.toUpperCase()).includes(currency))) return false;
    if (rules.salaryPeriods?.length && (!period || !rules.salaryPeriods.includes(period))) return false;
    return true;
  }

  private adapt(question: FormQuestion, raw: unknown): AnswerValue | null {
    if (raw === null || raw === undefined || raw === '') return null;
    if (question.type === 'number') {
      const number = typeof raw === 'number' ? raw : Number(String(raw).replace(/,/g, ''));
      return Number.isFinite(number) ? number : null;
    }
    if (question.type === 'date') {
      const value = String(raw);
      return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
    }
    if (question.type === 'checkbox') {
      const values = Array.isArray(raw) ? raw.map(String) : [String(raw)];
      if (!question.options?.length) return values;
      const selected = question.options.filter(option => values.some(value =>
        this.matcher.normalize(option) === this.matcher.normalize(value)));
      return selected.length ? selected : null;
    }
    if (question.type === 'radio' || question.type === 'select') {
      if (!question.options?.length) return typeof raw === 'boolean' ? raw : String(raw);
      if (typeof raw === 'boolean') {
        const expected = raw ? /^(?:yes|true|willing|available)\b/i : /^(?:no|false|not willing|unavailable)\b/i;
        return question.options.find(option => expected.test(option.trim())) || null;
      }
      if (typeof raw === 'number') return this.salaryRangeOption(question.options, raw);
      const normalized = this.matcher.normalize(String(raw));
      return question.options.find(option => this.matcher.normalize(option) === normalized) || null;
    }
    if (Array.isArray(raw)) return raw.map(String).join(', ');
    return typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean' ? String(raw) : null;
  }

  private salaryRangeOption(options: string[], amount: number): string | null {
    return options.find(option => {
      const numbers = [...option.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*(k|m|lakh|lac)?/gi)].map(match => {
        const value = Number(match[1].replace(/,/g, ''));
        const factor = /^(?:lakh|lac)$/i.test(match[2] || '') ? 100000
          : /^m$/i.test(match[2] || '') ? 1000000
            : /^k$/i.test(match[2] || '') ? 1000 : 1;
        return value * factor;
      });
      if (numbers.length >= 2) return amount >= numbers[0] && amount <= numbers[1];
      if (numbers.length === 1 && /(?:\+|above|more|over)/i.test(option)) return amount >= numbers[0];
      if (numbers.length === 1 && /(?:below|less|under|up to)/i.test(option)) return amount <= numbers[0];
      return numbers.length === 1 && amount === numbers[0];
    }) || null;
  }

  private acceptGemini(
    question: FormQuestion, match: QuestionMatch | null, answer: GeminiAnswer
  ): GeneratedAnswer | null {
    if (!this.geminiTypeCompatible(question, answer.answer)) return null;
    const value = this.adapt(question, answer.answer);
    if (value === null) return null;
    return {
      questionId: question.id, question: question.label, fieldType: question.type, value,
      confidence: answer.confidence, ...(match ? {matchedField: match.fieldKey} : {}),
      provenance: {
        source: 'gemini', model: answer.model || 'Gemini',
        detail: `${answer.provenance.reason} Evidence: ${answer.provenance.evidence.join('; ')}`
      }
    };
  }

  private geminiTypeCompatible(question: FormQuestion, value: AnswerValue): boolean {
    if (question.type === 'number') return typeof value === 'number';
    if (question.type === 'checkbox') return Array.isArray(value);
    if (question.type === 'radio' || question.type === 'select') {
      return typeof value === 'string' || typeof value === 'boolean';
    }
    return typeof value === 'string';
  }

  private toSuggestion(
    question: FormQuestion, match: QuestionMatch | null, answer: GeminiAnswer, job: JobAnswerContext
  ): ReusableAnswer {
    const now = new Date().toISOString();
    const normalizedQuestion = this.matcher.normalize(question.label);
    const id = createHash('sha256').update(`${normalizedQuestion}|${JSON.stringify(answer.answer)}`).digest('hex');
    const seniority = this.jobSeniority(job);
    const salaryText = this.salaryQuestionText(question);
    const currency = (question.currency || this.detectCurrency(salaryText) || job.currency)?.toUpperCase();
    const period = question.salaryPeriod || this.detectSalaryPeriod(salaryText);
    return {
      id, question: question.label, normalizedQuestion, fieldType: question.type, answer: answer.answer,
      confidence: answer.confidence, approved: false, ...(match ? {fieldKey: match.fieldKey} : {}),
      compatibility: {
        ...(job.title ? {roles: [job.title]} : {}),
        ...(seniority ? {seniorities: [seniority]} : {}),
        ...(currency ? {currencies: [currency]} : {}),
        ...(period ? {salaryPeriods: [period]} : {})
      },
      provenance: {source: 'gemini', model: answer.model, rationale: answer.provenance.reason},
      createdAt: now, updatedAt: now
    };
  }

  private toAnswer(question: FormQuestion, match: QuestionMatch | null, candidate: Candidate): GeneratedAnswer {
    return {
      questionId: question.id, question: question.label, fieldType: question.type,
      value: candidate.value, confidence: candidate.confidence,
      ...(match ? {matchedField: match.fieldKey} : {}),
      provenance: {
        source: candidate.source, detail: candidate.detail,
        ...(candidate.profileField ? {profileField: candidate.profileField} : {}),
        ...(candidate.suggestionId ? {suggestionId: candidate.suggestionId} : {})
      }
    };
  }

  private detectSeniority(value: string): Seniority | null {
    if (/\bintern(?:ship)?\b/i.test(value)) return 'intern';
    if (/\b(?:junior|jr\.?|entry[ -]?level|graduate|associate)\b/i.test(value)) return 'entry';
    if (/\b(?:lead|principal|staff|head)\b/i.test(value)) return 'lead';
    if (/\b(?:senior|sr\.?)\b/i.test(value)) return 'senior';
    if (/\b(?:mid|intermediate)\b/i.test(value)) return 'mid';
    return null;
  }

  private jobSeniority(job: JobAnswerContext): Seniority | null {
    return job.seniority || this.detectSeniority(job.title || '') || this.detectSeniority(job.description);
  }

  private detectCurrency(value: string): string | undefined {
    if (/\b(?:pkr|rs\.?)\b|₨/i.test(value)) return 'PKR';
    if (/\bUSD\b|\$/i.test(value)) return 'USD';
    if (/\bEUR\b|€/i.test(value)) return 'EUR';
    if (/\bGBP\b|£/i.test(value)) return 'GBP';
    return undefined;
  }

  private detectSalaryPeriod(value: string): SalaryPeriod | null {
    const monthly = /\b(?:monthly|per month|month|\/mo)\b/i.test(value);
    const annual = /\b(?:annual|annually|per annum|per year|yearly|\/yr)\b/i.test(value);
    return monthly === annual ? null : monthly ? 'monthly' : 'annual';
  }

  private salaryQuestionText(question: FormQuestion): string {
    return `${question.label} ${(question.options || []).join(' ')}`;
  }

  private equalValues(a: AnswerValue, b: AnswerValue): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
  }
}
