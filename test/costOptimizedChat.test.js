const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { once } = require('events');
const { spawn } = require('child_process');
const { createHaravanProduct, startHaravanStub } = require('./helpers/haravanStub');

async function availablePort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForServer(baseUrl, child) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Server dừng sớm với mã ${child.exitCode}.`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Server kiểm thử không khởi động.');
}

function routerInput(prompt) {
  const marker = 'INPUT_JSON:\n';
  const start = prompt.indexOf(marker);
  const end = prompt.lastIndexOf('\n\nOUTPUT_JSON_ONLY:');
  if (start < 0 || end < 0) return {};
  return JSON.parse(prompt.slice(start + marker.length, end));
}

test('product tư vấn gọi router + final có lý do; knowledge tìm web rồi tổng hợp có nguồn', async () => {
  const [port, aiPort, webPort] = await Promise.all([
    availablePort(),
    availablePort(),
    availablePort()
  ]);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghs-cost-flow-'));
  const haravanStub = await startHaravanStub([createHaravanProduct({
    id: 'football-tf',
    name: 'Giày Bóng Đá Mizuno Sala TF',
    handle: 'giay-bong-da-mizuno-sala-tf',
    brand: 'Mizuno',
    type: 'Giày Bóng Đá',
    tags: 'bóng đá TF sân 7',
    description: 'Đế TF phù hợp sân cỏ nhân tạo 5-7 người. Form êm cho sân 7.',
    color: 'Đen',
    sku: 'SP-TF-42',
    price: 1499000,
    compareAtPrice: 1700000,
    image: 'https://cdn.example.com/football-tf.jpg'
  })]);
  const aiPrompts = [];
  let webCalls = 0;

  const aiStub = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const prompt = String(body?.messages?.[0]?.content || '');
      aiPrompts.push(prompt);
      let result;

      if (prompt.includes('JSON_SCHEMA:')) {
        const input = routerInput(prompt);
        const knowledge = /FG và TF/i.test(input.message || '');
        const pinkNatural = /màu hồng.*cỏ tự nhiên/i.test(input.message || '');
        result = knowledge
          ? {
              intent: 'general_question',
              needDatabase: false,
              needWeb: true,
              webQuery: 'FG TF football boot sole official',
              showProducts: false,
              responseMode: 'brief',
              search: { query: input.message, customerNeeds: ['Phân biệt FG và TF'] }
            }
          : {
              intent: 'product_recommendation',
              needDatabase: true,
              needWeb: false,
              showProducts: true,
              responseMode: 'recommend',
              search: {
                query: input.message,
                categories: ['bóng đá'],
                colors: pinkNatural ? ['hồng'] : [],
                maxPrice: pinkNatural ? null : 2000000,
                customerNeeds: pinkNatural
                  ? ['Giày bóng đá màu hồng sân cỏ tự nhiên']
                  : ['Giày bóng đá sân 7 dưới 2 triệu'],
                requirements: [{
                  label: pinkNatural ? 'Sân cỏ tự nhiên' : 'Sân cỏ nhân tạo',
                  terms: pinkNatural ? ['FG', 'SG', 'cỏ tự nhiên'] : ['TF', 'AS', 'cỏ nhân tạo'],
                  scope: 'identity'
                }],
                excludeTerms: pinkNatural ? ['TF', 'AS'] : ['FG', 'SG'],
                limit: 3
              }
            };
      } else if (prompt.includes('QUY TẮC MODULE FINAL:')) {
        result = {
          reply: 'Mình chọn mẫu giày TF trong danh sách vì phù hợp sân cỏ nhân tạo 5–7 người và giá vẫn dưới 2 triệu.',
          suggestions: [
            { label: 'Kiểm tra size', prompt: 'Kiểm tra size còn hàng của mẫu vừa chọn' }
          ],
          needsAdmin: false
        };
      } else {
        result = {
          reply: 'FG thường dùng trên mặt sân cỏ tự nhiên chắc [1], còn TF dùng trên sân cỏ nhân tạo với nhiều đinh cao su nhỏ [2].',
          citationIds: [1, 2],
          suggestions: [
            { label: 'Cách chọn mặt sân', prompt: 'Hướng dẫn chọn đế theo mặt sân' }
          ]
        };
      }

      const payload = JSON.stringify({
        model: 'test-haiku',
        usage: { input_tokens: 300, output_tokens: 70 },
        content: [{ type: 'text', text: JSON.stringify(result) }]
      });
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      });
      res.end(payload);
    });
  });

  const webStub = http.createServer((req, res) => {
    webCalls += 1;
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const payload = JSON.stringify({
        results: [
          {
            title: 'FIFA official football guide',
            url: 'https://www.fifa.com/technical/football-technology',
            content: 'Official information about football surfaces and equipment.',
            score: 0.9
          },
          {
            title: 'Mizuno official football footwear',
            url: 'https://www.mizuno.com/football/footwear',
            content: 'Official football footwear and outsole information.',
            score: 0.85
          }
        ],
        usage: { credits: 1 }
      });
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      });
      res.end(payload);
    });
  });

  await Promise.all([
    new Promise((resolve, reject) => {
      aiStub.once('error', reject);
      aiStub.listen(aiPort, '127.0.0.1', resolve);
    }),
    new Promise((resolve, reject) => {
      webStub.once('error', reject);
      webStub.listen(webPort, '127.0.0.1', resolve);
    })
  ]);

  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      ...haravanStub.env,
      PORT: String(port),
      STORE_PATH: path.join(tempDir, 'store.json'),
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${aiPort}`,
      ANTHROPIC_AUTH_TOKEN: 'test-token',
      AI_MODEL: 'test-haiku',
      AI_ROUTER_MODEL: 'test-haiku',
      AI_CHAT_MODEL: 'test-haiku',
      AI_API_STYLE: 'anthropic',
      AI_AUTH_MODE: 'bearer',
      AI_MESSAGES_PATH: '/v1/messages',
      AI_COST_MODE: 'balanced',
      AI_ROUTER_ALWAYS: 'true',
      AI_PRODUCT_FINAL_ENABLED: 'false',
      KNOWLEDGE_WEB_ENABLED: 'true',
      TAVILY_API_KEY: 'test-tavily-key',
      TAVILY_API_URL: `http://127.0.0.1:${webPort}`,
      KNOWLEDGE_OFFICIAL_DOMAINS: 'fifa.com,mizuno.com'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    await waitForServer(baseUrl, child);

    const productResponse = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'product-cost-test',
        message: 'Tư vấn giày đá bóng sân 7 dưới 2 triệu'
      })
    });
    const product = await productResponse.json();
    assert.equal(productResponse.status, 200);
    assert.equal(aiPrompts.length, 2);
    assert.ok(aiPrompts[0].includes('JSON_SCHEMA:'));
    assert.ok(aiPrompts[1].includes('QUY TẮC MODULE FINAL:'));
    assert.match(product.reply, /vì/i);
    assert.ok(product.products.length > 0);
    assert.ok(product.products[0].images.length > 0);
    assert.ok(product.products[0].variants.length > 0);

    const unavailableResponse = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'unavailable-color-test',
        message: 'Tìm giày đá bóng màu hồng sân cỏ tự nhiên'
      })
    });
    const unavailable = await unavailableResponse.json();
    assert.equal(unavailableResponse.status, 200);
    assert.equal(aiPrompts.length, 3, 'Không được gọi Final AI khi kho không có sản phẩm khớp');
    assert.deepEqual(unavailable.products, []);
    assert.deepEqual(unavailable.suggestions.map((item) => item.label), ['Bỏ lọc màu']);
    assert.match(unavailable.reply, /chưa có.*màu hồng/i);

    const knowledgeResponse = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'knowledge-cost-test',
        message: 'FG và TF khác nhau thế nào?'
      })
    });
    const knowledge = await knowledgeResponse.json();
    assert.equal(knowledgeResponse.status, 200);
    assert.equal(aiPrompts.length, 5);
    assert.equal(webCalls, 1);
    assert.deepEqual(knowledge.products, []);
    assert.equal(knowledge.sources.length, 2);
    assert.match(knowledge.reply, /\[1\]/);

    const storedResponse = await fetch(`${baseUrl}/api/sessions/knowledge-cost-test`);
    const { session } = await storedResponse.json();
    assert.equal(session.messages.at(-1).sources.length, 2);
  } finally {
    child.kill('SIGTERM');
    if (child.exitCode === null) await once(child, 'exit');
    aiStub.closeAllConnections?.();
    webStub.closeAllConnections?.();
    await Promise.all([
      new Promise((resolve) => aiStub.close(resolve)),
      new Promise((resolve) => webStub.close(resolve))
    ]);
    await haravanStub.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
