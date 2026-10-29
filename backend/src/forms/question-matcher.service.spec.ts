import {FormQuestion} from './answering.types';
import {QuestionMatcherService} from './question-matcher.service';

describe('QuestionMatcherService', () => {
  const service = new QuestionMatcherService();
  const question = (label: string, type: FormQuestion['type'] = 'text'): FormQuestion => ({id: label, label, type});

  it.each(['Full Name', 'Applicant Name', 'Candidate Name', 'Your legal name (required)'])(
    'matches the name variation %s', label => {
      expect(service.match(question(label))?.fieldKey).toBe('name');
    }
  );

  it('does not confuse university name with applicant name', () => {
    expect(service.match(question('University Name'))?.fieldKey).toBe('university');
  });

  it.each([
    ['Expected annual salary in USD', 'salary'],
    ['Current Salary?', 'currentSalary'],
    ['Available date for interview', 'interviewAvailability'],
    ['Date of Joining?', 'availability'],
    ['Reason of switching current job?', 'reasonForLeaving'],
    ['Are you willing to relocate?', 'relocation'],
    ['Earliest start date', 'availability'],
    ['LinkedIn profile URL', 'linkedin'],
    ['Why would you like to join our company?', 'motivation']
  ])('matches %s to %s', (label, field) => {
    expect(service.match(question(label))?.fieldKey).toBe(field);
  });
});
