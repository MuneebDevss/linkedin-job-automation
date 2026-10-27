import {AnswerEngineService} from './answer-engine.service';
import {GeminiService} from './gemini.service';
import {QuestionMatcherService} from './question-matcher.service';
import {ResumeSelectorService} from './resume-selector.service';
import {ProfileStoreService} from '../profile/profile-store.service';
import {ProfileDocument} from '../profile/profile.types';

function profile(): ProfileDocument {
  return {
    schemaVersion: 1,
    verified: {
      name: 'Muneeb Ur Rehman', email: 'munib.urehmann@gmail.com', phone: null,
      linkedin: 'https://linkedin.example/muneeb', github: 'https://github.example/muneeb',
      location: 'Islamabad, Pakistan', university: 'Example University', cgpa: null,
      employmentStatus: null, availability: {status: null, date: '2026-11-15'},
      relocation: {willing: true, locations: []}, yearsOfExperience: 2, workAuthorization: null,
      willing_to_work_onsite: true, willing_to_relocate: true, willing_to_work_night_shifts: true,
      flexible_working_hours: true, willing_to_learn: true, salary_negotiable: true,
      strengths: ['Node.js', 'TypeScript'],
      salaryExpectations: {
        intern: {PKR: {monthly: null, annual: null}},
        entry: {PKR: {monthly: 100000, annual: null}},
        mid: {PKR: {monthly: null, annual: null}},
        senior: {PKR: {monthly: null, annual: null}},
        lead: {PKR: {monthly: null, annual: null}}
      }
    },
    verification: {}, approvedReusableAnswers: [], generatedSuggestions: [],
    resumeCatalog: [{
      id: 'fullstack', fileName: 'fullstack.pdf', path: '/resumes/fullstack.pdf',
      skills: ['Node.js', 'TypeScript'], summary: 'Built TypeScript and Node.js services.'
    }]
  };
}

describe('AnswerEngineService', () => {
  let document: ProfileDocument;
  let store: {load: jest.Mock; addGeneratedSuggestions: jest.Mock};
  let gemini: {answer: jest.Mock};
  let service: AnswerEngineService;

  beforeEach(() => {
    document = profile();
    store = {load: jest.fn(async () => document), addGeneratedSuggestions: jest.fn()};
    gemini = {answer: jest.fn()};
    service = new AnswerEngineService(
      store as unknown as ProfileStoreService,
      new QuestionMatcherService(),
      new ResumeSelectorService(),
      gemini as unknown as GeminiService
    );
  });

  it('keeps verified data when an approved reusable answer conflicts', async () => {
    document.approvedReusableAnswers.push({
      id: 'old-email', question: 'Email address', normalizedQuestion: 'email address',
      fieldType: 'text', answer: 'wrong@example.com', confidence: 'high', approved: true,
      fieldKey: 'email', provenance: {source: 'manual'},
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z'
    });
    const result = await service.generate({
      job: {title: 'Full Stack Developer', description: 'Node.js and TypeScript'},
      questions: [{id: 'email', label: 'Applicant Email Address', type: 'text'}]
    });
    expect(result.answers[0]).toMatchObject({
      value: 'munib.urehmann@gmail.com', provenance: {source: 'verified_profile'}
    });
    expect(result.conflicts).toEqual([expect.objectContaining({ignoredSuggestionId: 'old-email'})]);
    expect(gemini.answer).not.toHaveBeenCalled();
  });

  it('returns unresolved answers when Gemini fails', async () => {
    gemini.answer.mockRejectedValue(new Error('Gemini unavailable'));
    const result = await service.generate({
      job: {title: 'Full Stack Developer', description: 'Build APIs'},
      questions: [{id: 'motivation', label: 'Why do you want to join us?', type: 'long_text'}]
    });
    expect(result.answers[0]).toMatchObject({value: null, provenance: {source: 'unresolved'}});
    expect(store.addGeneratedSuggestions).not.toHaveBeenCalled();
  });

  it('keeps monthly and annual salary periods distinct', async () => {
    gemini.answer.mockResolvedValue([]);
    const result = await service.generate({
      job: {title: 'Junior Developer', description: 'Entry-level role', seniority: 'entry', currency: 'PKR'},
      questions: [
        {id: 'monthly', label: 'Expected monthly salary', type: 'number', salaryPeriod: 'monthly'},
        {id: 'annual', label: 'Expected annual salary', type: 'number', salaryPeriod: 'annual'},
        {id: 'range', label: 'Expected salary', type: 'select', currency: 'PKR', salaryPeriod: 'monthly',
          options: ['PKR 80k - 120k per month', 'PKR 121k - 160k per month']},
        {id: 'usd', label: 'Expected monthly salary (USD)', type: 'number', salaryPeriod: 'monthly'}
      ]
    });
    expect(result.answers[0]).toMatchObject({value: 100000, provenance: {source: 'verified_profile'}});
    expect(result.answers[1]).toMatchObject({value: 1200000, provenance: {source: 'deterministic'}});
    expect(result.answers[2]).toMatchObject({value: 'PKR 80k - 120k per month', provenance: {source: 'verified_profile'}});
    expect(result.answers[3]).toMatchObject({value: null, provenance: {source: 'unresolved'}});
  });

  it('adapts verified values to number, date, radio, checkbox, select, and long-answer fields', async () => {
    const result = await service.generate({
      job: {title: 'Full Stack Developer', description: 'Node.js'},
      questions: [
        {id: 'experience', label: 'Years of experience', type: 'number'},
        {id: 'date', label: 'Earliest start date', type: 'date'},
        {id: 'relocate', label: 'Willing to relocate?', type: 'radio', options: ['Yes', 'No']},
        {id: 'relocate-select', label: 'Open to relocation', type: 'select', options: ['Yes', 'No']},
        {id: 'skills', label: 'Key skills', type: 'checkbox', options: ['Node.js', 'Java']},
        {id: 'strengths', label: 'Core strengths', type: 'long_text'}
      ]
    });
    expect(result.answers.map(answer => answer.value)).toEqual([
      2, '2026-11-15', 'Yes', 'Yes', ['Node.js'], 'Node.js, TypeScript'
    ]);
  });

  it('uses verified positive employment preferences without calling Gemini', async () => {
    const result = await service.generate({
      job: {title: 'Support Engineer', description: 'Onsite evening shift with learning opportunities'},
      questions: [
        {id: 'onsite', label: 'Are you comfortable working onsite?', type: 'radio', options: ['Yes', 'No']},
        {id: 'shift', label: 'Are you willing to work night shifts?', type: 'select', options: ['Yes', 'No']},
        {id: 'hours', label: 'Can you work flexible working hours?', type: 'checkbox', options: ['I am flexible']},
        {id: 'learn', label: 'Are you willing to learn new technologies?', type: 'radio', options: ['Yes', 'No']},
        {id: 'negotiable', label: 'Is compensation negotiable?', type: 'select', options: ['Negotiable', 'Fixed']}
      ]
    });
    expect(result.answers.map(answer => answer.value)).toEqual([
      'Yes', 'Yes', ['I am flexible'], 'Yes', 'Negotiable'
    ]);
    expect(result.answers.every(answer => answer.provenance.source === 'verified_profile')).toBe(true);
    expect(gemini.answer).not.toHaveBeenCalled();
  });

  it('selects the nearest salary range only when salary flexibility is verified', async () => {
    const result = await service.generate({
      job: {title: 'Junior Developer', description: 'Entry role', seniority: 'entry', currency: 'PKR'},
      questions: [{
        id: 'salary', label: 'Expected monthly salary', type: 'select', salaryPeriod: 'monthly', currency: 'PKR',
        options: ['PKR 40k - 60k per month', 'PKR 120k - 150k per month']
      }]
    });
    expect(result.answers[0]).toMatchObject({value: 'PKR 120k - 150k per month', provenance: {source: 'deterministic'}});
  });
});
