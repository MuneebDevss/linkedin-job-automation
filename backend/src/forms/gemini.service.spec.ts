import {ConfigService} from '@nestjs/config';
import {GeminiService} from './gemini.service';

describe('GeminiService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('fails closed when credentials are not configured', async () => {
    const service = new GeminiService(new ConfigService({
      geminiApiKey: '', geminiModel: 'gemini-3.5-flash-lite', geminiTimeoutMs: 1000
    }) as never);
    await expect(service.answer({
      job: {description: 'A role'},
      verifiedProfile: {} as never,
      resume: null,
      questions: [{id: 'q1', label: 'Why us?', type: 'long_text'}]
    })).rejects.toThrow('Gemini is not configured');
  });

  it('ignores a structured answer whose declared type conflicts with its value', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      candidates: [{content: {parts: [{text: JSON.stringify({
        answers: [{
          questionId: 'q1', answer: {kind: 'number', stringValue: 'not a number'},
          confidence: 'high', reusable: false,
          provenance: {reason: 'test', evidence: ['test context']}
        }]
      })}]}}]
    }), {status: 200, headers: {'content-type': 'application/json'}}));
    const service = new GeminiService(new ConfigService({
      geminiApiKey: 'test-key', geminiModel: 'gemini-test', geminiTimeoutMs: 1000
    }) as never);
    await expect(service.answer({
      job: {description: 'A role'}, verifiedProfile: {} as never, resume: null,
      questions: [{id: 'q1', label: 'Years of experience', type: 'number'}]
    })).resolves.toEqual([]);
    expect(String(fetchMock.mock.calls[0][0])).not.toContain('test-key');
  });

  it('keeps valid answers when another answer in the same Gemini batch is malformed', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      candidates: [{content: {parts: [{text: JSON.stringify({
        answers: [
          {
            questionId: 'invalid', answer: {kind: 'string'}, confidence: 'high', reusable: true,
            provenance: {reason: 'missing value', evidence: ['test context']}
          },
          {
            questionId: 'valid', answer: {kind: 'string', stringValue: 'Grounded answer'},
            confidence: 'high', reusable: true,
            provenance: {reason: 'supported', evidence: ['verified profile']}
          }
        ]
      })}]}}]
    }), {status: 200, headers: {'content-type': 'application/json'}}));
    const service = new GeminiService(new ConfigService({
      geminiApiKey: 'test-key', geminiModel: 'gemini-test', geminiTimeoutMs: 1000
    }) as never);

    await expect(service.answer({
      job: {description: 'A role'}, verifiedProfile: {} as never, resume: null,
      questions: [
        {id: 'invalid', label: 'Invalid', type: 'text'},
        {id: 'valid', label: 'Valid', type: 'text'}
      ]
    })).resolves.toEqual([expect.objectContaining({questionId: 'valid', answer: 'Grounded answer'})]);
  });
});
