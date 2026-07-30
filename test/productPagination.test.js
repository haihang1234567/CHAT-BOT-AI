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

function productCsv() {
  const header = [
    'Mã sản phẩm', 'Mã biến thể', 'Url', 'Tên', 'Mô tả', 'Trích dẫn', 'Hãng',
    'Loại sản phẩm', 'Tag', 'Thuộc tính 1', 'Giá trị thuộc tính 1',
    'Thuộc tính 2', 'Giá trị thuộc tính 2', 'Mã phiên bản sản phẩm',
    'Số lượng tồn kho', 'Giá', 'Giá so sánh', 'Link hình'
  ].join(',');
  const rows = Array.from({ length: 7 }, (_, index) => {
    const number = index + 1;
    return [
      `pickle-shoe-${number}`,
      `pickle-shoe-${number}-v1`,
      `giay-pickleball-${number}`,
      `Giày Pickleball Mẫu ${number}`,
      'Giày thi đấu pickleball',
      'Phù hợp chơi pickleball',
      'Promax',
      'Giày Pickleball',
      'pickleball',
      'Màu',
      'Trắng',
      'Size',
      '42',
      `PICK-${number}-42`,
      '5',
      String(600000 + number * 10000),
      String(700000 + number * 10000),
      `https://cdn.example.com/pickle-${number}.jpg`
    ].join(',');
  });
  return [header, ...rows].join('\n');
}

test('nút Xem thêm phân trang toàn bộ sản phẩm bằng code và không gọi thêm AI', async () => {
  const [port, aiPort] = await Promise.all([availablePort(), availablePort()]);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghs-pagination-'));
  const productCsvPath = path.join(tempDir, 'products.csv');
  fs.writeFileSync(productCsvPath, productCsv());
  let aiCalls = 0;

  const aiStub = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      aiCalls += 1;
      const result = {
        intent: 'search_product',
        needDatabase: true,
        needWeb: false,
        showProducts: true,
        responseMode: 'brief',
        clarificationQuestion: '',
        consultation: { ready: true, pendingField: '' },
        search: {
          query: 'giày pickleball',
          categories: ['pickleball'],
          customerNeeds: ['Giày chơi pickleball'],
          requirements: [{
            label: 'Đúng bộ môn pickleball',
            terms: ['pickleball'],
            scope: 'identity'
          }],
          inStockOnly: true,
          limit: 3
        }
      };
      const payload = JSON.stringify({
        model: 'test-haiku',
        usage: { input_tokens: 200, output_tokens: 50 },
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
      PRODUCT_CSV_PATH: productCsvPath,
      HARAVAN_ACCESS_TOKEN: '',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${aiPort}`,
      ANTHROPIC_AUTH_TOKEN: 'test-token',
      AI_MODEL: 'test-haiku',
      AI_ROUTER_MODEL: 'test-haiku',
      AI_CHAT_MODEL: 'test-haiku',
      AI_API_STYLE: 'anthropic',
      AI_AUTH_MODE: 'bearer',
      AI_MESSAGES_PATH: '/v1/messages',
      AI_ROUTER_ALWAYS: 'true',
      AI_PRODUCT_FINAL_ENABLED: 'false',
      CHAT_PRODUCT_PAGE_SIZE: '3',
      KNOWLEDGE_WEB_ENABLED: 'false'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  const sessionId = 'pagination-test';

  async function post(pathname, body) {
    const response = await fetch(`${baseUrl}${pathname}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await response.json();
    assert.equal(response.status, 200, JSON.stringify(data));
    return data;
  }

  try {
    await waitForServer(baseUrl, child);

    const first = await post('/api/chat', {
      sessionId,
      message: 'Cho xem giày pickleball'
    });
    assert.equal(aiCalls, 1);
    assert.equal(first.products.length, 3);
    assert.equal(first.hasMore, true);
    assert.ok(first.suggestions.some((item) => item.action === 'load_more_products'));

    const second = await post('/api/chat/products/more', { sessionId });
    assert.equal(aiCalls, 1);
    assert.equal(second.products.length, 3);
    assert.equal(second.hasMore, true);
    assert.ok(second.suggestions.some((item) => item.action === 'load_more_products'));

    const third = await post('/api/chat/products/more', { sessionId });
    assert.equal(aiCalls, 1);
    assert.equal(third.products.length, 1);
    assert.equal(third.hasMore, false);
    assert.ok(!third.suggestions.some((item) => item.action === 'load_more_products'));

    const allIds = [...first.products, ...second.products, ...third.products]
      .map((product) => product.id);
    assert.equal(new Set(allIds).size, 7);

    const sessionResponse = await fetch(`${baseUrl}/api/sessions/${sessionId}`);
    const { session } = await sessionResponse.json();
    const lastAssistant = [...session.messages].reverse()
      .find((message) => message.role === 'assistant');
    assert.equal(lastAssistant.source, 'product-pagination-code');
    assert.equal(lastAssistant.pagination.shownProductIds.length, 7);
  } finally {
    child.kill('SIGTERM');
    if (child.exitCode === null) await once(child, 'exit');
    aiStub.closeAllConnections?.();
    await new Promise((resolve) => aiStub.close(resolve));
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('giao diện gọi endpoint phân trang riêng thay vì gửi lại prompt cho AI', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '..', 'public', 'js', 'app.js'),
    'utf8'
  );
  assert.match(source, /action === 'load_more_products'/);
  assert.match(source, /fetch\('\/api\/chat\/products\/more'/);
});
