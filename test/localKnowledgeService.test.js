const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LocalKnowledgeService = require('../src/localKnowledgeService');
const KnowledgeService = require('../src/knowledgeService');

function writeEntries(directory, entries) {
  fs.writeFileSync(
    path.join(directory, 'entries.json'),
    JSON.stringify({ version: 1, entries }),
    'utf8'
  );
}

test('ưu tiên kiến thức nội bộ đủ điểm và không gọi tìm kiếm web', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ghs-knowledge-'));
  writeEntries(directory, [{
    id: 'football-tf',
    title: 'Đế TF cho bóng đá sân cỏ nhân tạo',
    sports: ['bóng đá'],
    questions: ['Đế TF dùng cho sân nào?'],
    keywords: ['TF', 'sân cỏ nhân tạo'],
    content: 'TF là loại đế dành cho bóng đá trên sân cỏ nhân tạo.',
    source: {
      title: 'Nguồn chính thức',
      url: 'https://www.mizuno.com/football/tf'
    },
    verifiedAt: '2026-07-29',
    expiresAt: '2099-01-01'
  }]);

  try {
    const local = new LocalKnowledgeService({
      localEnabled: true,
      localDir: directory,
      localMaxResults: 3,
      localMinScore: 2,
      localSufficientScore: 8,
      contentChars: 900,
      officialDomains: ['mizuno.com']
    });
    let webCalls = 0;
    const knowledge = new KnowledgeService(
      { maxResults: 3 },
      local,
      {
        search: async () => {
          webCalls += 1;
          return { sources: [], cached: false, credits: 1, warning: '' };
        }
      }
    );

    const result = await knowledge.search('TF football outsole', {
      originalQuestion: 'Đế TF dùng cho sân nào?'
    });
    assert.equal(webCalls, 0);
    assert.equal(result.provider, 'local');
    assert.equal(result.credits, 0);
    assert.equal(result.sources.length, 1);
    assert.equal(result.sources[0].knowledgeId, 'football-tf');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('bỏ nguồn không chính thống và dùng web khi kho nội bộ chưa đủ', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ghs-knowledge-'));
  writeEntries(directory, [{
    id: 'bad-source',
    title: 'Nguồn không hợp lệ',
    questions: ['Cách chọn giày'],
    keywords: ['giày'],
    content: 'Nội dung không được sử dụng.',
    source: {
      title: 'Blog bất kỳ',
      url: 'https://random-blog.example/shoes'
    }
  }]);

  try {
    const local = new LocalKnowledgeService({
      localEnabled: true,
      localDir: directory,
      localMaxResults: 3,
      localMinScore: 2,
      localSufficientScore: 8,
      contentChars: 900,
      officialDomains: ['mizuno.com']
    });
    let webCalls = 0;
    const knowledge = new KnowledgeService(
      { maxResults: 3 },
      local,
      {
        search: async () => {
          webCalls += 1;
          return {
            sources: [{
              title: 'Official',
              url: 'https://www.mizuno.com/shoes',
              domain: 'mizuno.com',
              content: 'Official content.'
            }],
            cached: false,
            credits: 1,
            warning: ''
          };
        }
      }
    );

    const result = await knowledge.search('Cách chọn giày');
    assert.equal(webCalls, 1);
    assert.equal(result.provider, 'web');
    assert.equal(result.sources.length, 1);
    assert.equal(result.sources[0].domain, 'mizuno.com');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
