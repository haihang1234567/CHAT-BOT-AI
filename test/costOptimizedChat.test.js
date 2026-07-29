const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { once } = require('events');
const { spawn } = require('child_process');

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

function promptPayload(body) {
  const prompt = String(body?.messages?.[0]?.content || '');
  const start = prompt.indexOf('INPUT_JSON:\n');
  const end = prompt.lastIndexOf('\n\nOUTPUT_JSON_ONLY:');
  if (start < 0 || end < 0) return {};
  return JSON.parse(prompt.slice(start + 'INPUT_JSON:\n'.length, end));
}

test('knowledge chỉ trả text, product dùng 1 AI call rồi code dựng đủ thẻ biến thể', async () => {
  const [port, aiPort] = await Promise.all([availablePort(), availablePort()]);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghs-cost-flow-'));
  const prompts = [];

  const aiStub = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const prompt = String(body?.messages?.[0]?.content || '');
      prompts.push(prompt);
      const input = promptPayload(body);
      const isKnowledge = /FG và TF/i.test(input.customerMessage || '');
      const firstProductId = input.databaseResults?.[0]?.id;
      const result = isKnowledge
        ? {
            reply: 'FG phù hợp sân cỏ tự nhiên, còn TF phù hợp sân cỏ nhân tạo.',
            productIds: [],
            suggestions: [
              { label: 'Xem giải thích chi tiết', prompt: 'Hãy giải thích chi tiết hơn câu trả lời vừa rồi' },
              { label: 'Tư vấn giày sân 7', prompt: 'Tư vấn giày sân 7 phù hợp với tôi' }
            ],
            needsAdmin: false
          }
        : {
            reply: 'Mình đã chọn được mẫu phù hợp; ảnh, màu và size nằm trong thẻ bên dưới.',
            productIds: firstProductId ? [firstProductId] : [],
            suggestions: [
              { label: 'Kiểm tra màu và size', prompt: 'Kiểm tra màu và size còn hàng' }
            ],
            needsAdmin: false
          };
      const payload = JSON.stringify({
        model: 'test-haiku',
        usage: { input_tokens: 900, output_tokens: 90 },
        content: [{ type: 'text', text: JSON.stringify(result) }]
      });
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      });
      res.end(payload);
    });
  });
  await new Promise((resolve, reject) => {
    aiStub.once('error', reject);
    aiStub.listen(aiPort, '127.0.0.1', resolve);
  });

  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      STORE_PATH: path.join(tempDir, 'store.json'),
      PRODUCT_SOURCE: 'csv',
      HARAVAN_ACCESS_TOKEN: '',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${aiPort}`,
      ANTHROPIC_AUTH_TOKEN: 'test-token',
      AI_MODEL: 'test-haiku',
      AI_ROUTER_MODEL: 'test-haiku',
      AI_CHAT_MODEL: 'test-haiku',
      AI_API_STYLE: 'anthropic',
      AI_AUTH_MODE: 'bearer',
      AI_MESSAGES_PATH: '/v1/messages',
      AI_COST_MODE: 'balanced'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    await waitForServer(baseUrl, child);

    const knowledgeResponse = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'knowledge-cost-test', message: 'FG và TF khác nhau thế nào?' })
    });
    const knowledge = await knowledgeResponse.json();
    assert.equal(knowledgeResponse.status, 200);
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].includes('MODULE ROUTER'), false);
    assert.deepEqual(knowledge.products, []);
    assert.equal(knowledge.suggestions.length, 2);

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
    assert.equal(prompts.length, 2);
    assert.equal(prompts[1].includes('MODULE ROUTER'), false);
    assert.ok(product.products.length > 0);
    assert.ok(product.products[0].images.length > 0);
    assert.ok(product.products[0].variants.length > 0);
    assert.equal(product.suggestions.length, 1);

    const storedResponse = await fetch(`${baseUrl}/api/sessions/knowledge-cost-test`);
    const { session } = await storedResponse.json();
    assert.equal(session.messages.at(-1).suggestions.length, 2);
  } finally {
    child.kill('SIGTERM');
    if (child.exitCode === null) await once(child, 'exit');
    aiStub.closeAllConnections?.();
    await new Promise((resolve) => aiStub.close(resolve));
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
