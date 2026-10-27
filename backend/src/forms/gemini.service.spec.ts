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

  it('rejects structured output whose declared answer type conflicts with its value', async () => {
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
    })).rejects.toThrow('Gemini answer generation failed');
    expect(String(fetchMock.mock.calls[0][0])).not.toContain('test-key');
  });
});
