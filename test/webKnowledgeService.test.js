const test = require('node:test');
const assert = require('node:assert/strict');

const WebKnowledgeService = require('../src/webKnowledgeService');

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body)
  };
}

test('chỉ nhận nguồn trong whitelist chính thống và cache câu hỏi lặp lại', async () => {
  let calls = 0;
  let requestBody;
  const service = new WebKnowledgeService({
    enabled: true,
    apiKey: 'test-key',
    endpoint: 'https://api.tavily.com/search',
    timeoutMs: 3000,
    maxResults: 3,
    contentChars: 300,
    cacheTtlMs: 60000,
    officialDomains: ['theifab.com', 'fifa.com']
  }, async (_url, options) => {
    calls += 1;
    requestBody = JSON.parse(options.body);
    return jsonResponse({
      results: [
        {
          title: 'Official source',
          url: 'https://www.theifab.com/laws/latest/',
          content: 'Official football information.',
          score: 0.9
        },
        {
          title: 'Untrusted blog',
          url: 'https://random-blog.example/tf-shoes',
          content: 'Unsupported claim.',
          score: 0.99
        }
      ],
      usage: { credits: 1 }
    });
  });

  const first = await service.search('Luật bóng đá chính thức');
  const second = await service.search('Luật bóng đá chính thức');

  assert.equal(calls, 1);
  assert.deepEqual(requestBody.include_domains, ['theifab.com', 'fifa.com']);
  assert.equal(requestBody.search_depth, 'basic');
  assert.equal(requestBody.include_answer, false);
  assert.deepEqual(first.sources.map((source) => source.domain), ['theifab.com']);
  assert.equal(first.credits, 1);
  assert.equal(second.cached, true);
});

test('không có API key thì trả rỗng, không cho AI suy đoán', async () => {
  const service = new WebKnowledgeService({
    enabled: true,
    apiKey: '',
    endpoint: 'https://api.tavily.com/search',
    officialDomains: ['fifa.com']
  });

  const result = await service.search('TF là gì?');
  assert.deepEqual(result.sources, []);
  assert.match(result.warning, /TAVILY_API_KEY/i);
});
