const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

async function availablePort() {
  const server = net.createServer();
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
    if (child.exitCode !== null) {
      throw new Error(`Server test đã dừng với mã ${child.exitCode}.`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Server test không khởi động kịp thời.');
}

test('admin tìm và gửi thẻ sản phẩm vào đúng cuộc trò chuyện', async () => {
  const port = await availablePort();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghs-admin-products-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      STORE_PATH: path.join(tempDir, 'store.json'),
      PRODUCT_SOURCE: 'csv',
      HARAVAN_ACCESS_TOKEN: '',
      ANTHROPIC_AUTH_TOKEN: '',
      AI_MODEL: '',
      AI_ROUTER_MODEL: '',
      AI_CHAT_MODEL: '',
      ADMIN_PASSWORD: 'test-admin-password'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    await waitForServer(baseUrl, child);

    const unauthorized = await fetch(`${baseUrl}/api/admin/products/search?q=pickleball`);
    assert.equal(unauthorized.status, 401);

    const loginResponse = await fetch(`${baseUrl}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'test-admin-password' })
    });
    assert.equal(loginResponse.status, 200);
    const { token } = await loginResponse.json();
    const adminHeaders = {
      'Content-Type': 'application/json',
      'X-Admin-Token': token
    };

    const searchResponse = await fetch(`${baseUrl}/api/admin/products/search?q=mizuno`, {
      headers: adminHeaders
    });
    assert.equal(searchResponse.status, 200);
    const searchResult = await searchResponse.json();
    assert.ok(searchResult.products.length > 0);
    const product = searchResult.products[0];

    const sessionId = 'customer-admin-product-test';
    const sessionResponse = await fetch(`${baseUrl}/api/sessions/${sessionId}`);
    assert.equal(sessionResponse.status, 200);

    const sendResponse = await fetch(`${baseUrl}/api/admin/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        adminName: 'Nhân viên kiểm thử',
        message: 'Mình gửi bạn mẫu này để tham khảo nhé.',
        productIds: [product.id]
      })
    });
    assert.equal(sendResponse.status, 200);
    const sent = await sendResponse.json();
    assert.deepEqual(sent.message.productIds, [product.id]);
    assert.deepEqual(sent.message.products.map((item) => item.id), [product.id]);

    const restoredResponse = await fetch(`${baseUrl}/api/sessions/${sessionId}`);
    const { session } = await restoredResponse.json();
    assert.equal(session.status, 'human');
    assert.equal(session.assignedTo, 'Nhân viên kiểm thử');
    assert.deepEqual(session.messages.at(-1).productIds, [product.id]);
  } finally {
    child.kill('SIGTERM');
    if (child.exitCode === null) await once(child, 'exit');
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('AI chỉ tạo bản nháp khi Admin bấm gợi ý và không tự gửi cho khách', async () => {
  const [port, aiPort] = await Promise.all([availablePort(), availablePort()]);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghs-admin-ai-suggestion-'));
  let aiCallCount = 0;
  let suggestedProductId = '';

  const aiStub = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      aiCallCount += 1;
      const reply = {
        reply: 'Shop có mẫu giày bóng chuyền phù hợp. Bạn cho mình xin size để kiểm tra biến thể nhé.',
        productIds: [suggestedProductId],
        suggestions: [{
          label: 'Kiểm tra màu và size',
          prompt: 'Kiểm tra màu và size còn hàng của mẫu vừa gợi ý'
        }],
        needsAdmin: false
      };
      const payload = JSON.stringify({
        content: [{ type: 'text', text: JSON.stringify(reply) }]
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
      ADMIN_PASSWORD: 'test-admin-password'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    await waitForServer(baseUrl, child);
    const loginResponse = await fetch(`${baseUrl}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'test-admin-password' })
    });
    const { token } = await loginResponse.json();
    const adminHeaders = {
      'Content-Type': 'application/json',
      'X-Admin-Token': token
    };

    const searchResponse = await fetch(`${baseUrl}/api/admin/products/search?q=mizuno`, {
      headers: adminHeaders
    });
    const searchResult = await searchResponse.json();
    assert.ok(searchResult.products.length > 0);
    suggestedProductId = searchResult.products[0].id;

    const sessionId = 'customer-admin-ai-suggestion-test';
    await fetch(`${baseUrl}/api/sessions/${sessionId}`);
    await fetch(`${baseUrl}/api/admin/sessions/${sessionId}/claim`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ adminName: 'Nhân viên kiểm thử' })
    });
    const customerResponse = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        message: 'Shop có giày bóng chuyền không?'
      })
    });
    const customerResult = await customerResponse.json();
    assert.equal(customerResult.reply, null);
    assert.equal(aiCallCount, 0);

    const beforeResponse = await fetch(`${baseUrl}/api/sessions/${sessionId}`);
    const { session: beforeSession } = await beforeResponse.json();
    const customerMessage = [...beforeSession.messages].reverse().find((message) => message.role === 'user');
    const messageCountBefore = beforeSession.messages.length;

    const suggestionResponse = await fetch(`${baseUrl}/api/admin/sessions/${sessionId}/ai-suggestion`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ messageId: customerMessage.id })
    });
    assert.equal(suggestionResponse.status, 200);
    const suggestion = await suggestionResponse.json();
    assert.equal(aiCallCount, 1);
    assert.match(suggestion.suggestion, /giày bóng chuyền phù hợp/i);
    assert.deepEqual(suggestion.products.map((product) => product.id), [suggestedProductId]);

    const afterResponse = await fetch(`${baseUrl}/api/sessions/${sessionId}`);
    const { session: afterSession } = await afterResponse.json();
    assert.equal(afterSession.messages.length, messageCountBefore);
    assert.equal(afterSession.messages.at(-1).role, 'user');
  } finally {
    child.kill('SIGTERM');
    if (child.exitCode === null) await once(child, 'exit');
    aiStub.closeAllConnections?.();
    await new Promise((resolve) => aiStub.close(resolve));
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
