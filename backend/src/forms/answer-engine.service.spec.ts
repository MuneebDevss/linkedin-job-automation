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
      currentSalary: {PKR: {monthly: 0, annual: 0}},
      reasonForLeaving: 'Seeking new opportunities for growth and learning.',
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
    store = {
      load: jest.fn(async () => document),
      addGeneratedSuggestions: jest.fn(async (suggestions: ProfileDocument['generatedSuggestions']) =>
        document.generatedSuggestions.push(...suggestions))
    };
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

  it('grounds current salary, expected salary, immediate dates, and switching reason in the profile', async () => {
    document.verified.availability = {status: 'Immediate', date: null};
    const today = new Date();
    const localToday = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const result = await service.generate({
      job: {title: 'Android Developer', description: 'Requires 1 to 2 years of experience'},
      questions: [
        {id: 'current', label: 'Current Salary?', type: 'text'},
        {id: 'expected', label: 'Expected Salary?', type: 'text'},
        {id: 'interview', label: 'Available date for interview', type: 'date'},
        {id: 'joining', label: 'Date of Joining?', type: 'date'},
        {id: 'switching', label: 'Reason of switching current job?', type: 'long_text'}
      ]
    });

    expect(result.answers.map(answer => answer.value)).toEqual([
      'PKR 0 per month', 'PKR 100000 per month', localToday, localToday,
      'Seeking new opportunities for growth and learning.'
    ]);
    expect(gemini.answer).not.toHaveBeenCalled();
  });

  it('persists and reuses grounded reusable Gemini answers without a second model call', async () => {
    gemini.answer.mockResolvedValue([{
      questionId: 'motivation', answer: 'I enjoy building reliable products.', confidence: 'high', reusable: true,
      provenance: {reason: 'Supported by the resume.', evidence: ['resume summary']}, model: 'gemini-test'
    }]);
    const input = {
      job: {title: 'Product Engineer', description: 'Build reliable products'},
      questions: [{id: 'motivation', label: 'What motivates you professionally?', type: 'long_text' as const}]
    };

    const generated = await service.generate(input);
    const reused = await service.generate(input);

    expect(generated.answers[0]).toMatchObject({value: 'I enjoy building reliable products.', provenance: {source: 'gemini'}});
    expect(document.generatedSuggestions[0]).toMatchObject({approved: true, answer: 'I enjoy building reliable products.'});
    expect(reused.answers[0]).toMatchObject({value: 'I enjoy building reliable products.', provenance: {source: 'approved_suggestion'}});
    expect(gemini.answer).toHaveBeenCalledTimes(1);
  });

  it('persists a non-reusable Gemini answer only for the exact same job', async () => {
    gemini.answer.mockResolvedValue([{
      questionId: 'motivation', answer: 'This role matches my TypeScript background.', confidence: 'high', reusable: false,
      provenance: {reason: 'Specific to this role.', evidence: ['job description']}, model: 'gemini-test'
    }]);
    const question = [{id: 'motivation', label: 'Why this specific role?', type: 'long_text' as const}];
    const job = {title: 'API Engineer', description: 'Build TypeScript APIs'};

    await service.generate({job, questions: question});
    const sameJob = await service.generate({job, questions: question});
    await service.generate({job: {...job, description: 'Build Python data pipelines'}, questions: question});

    expect(sameJob.answers[0]).toMatchObject({provenance: {source: 'approved_suggestion'}});
    expect(document.generatedSuggestions[0].compatibility?.jobFingerprints).toHaveLength(1);
    expect(gemini.answer).toHaveBeenCalledTimes(2);
  });
});
