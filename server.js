const loadEnv = require('./src/env');
loadEnv();

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const config = require('./src/config');
const JsonStore = require('./src/store');
const { ProductService, normalizeText } = require('./src/productService');
const AiService = require('./src/aiService');

const store = new JsonStore(config.storePath);
const products = new ProductService(config.productCsvPath, config.shopDomain);
const ai = new AiService(config.ai, products);
const publicDir = path.resolve(__dirname, 'public');

const customerStreams = new Map();
const adminStreams = new Set();
const adminTokens = new Set();

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon'
};

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

async function readJson(req, maxBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('Dữ liệu gửi lên quá lớn.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (_) {
        reject(new Error('Dữ liệu JSON không hợp lệ.'));
      }
    });
    req.on('error', reject);
  });
}

function sseWrite(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function emitAdmin(event, data) {
  for (const res of adminStreams) {
    try { sseWrite(res, event, data); } catch (_) { adminStreams.delete(res); }
  }
}

function emitCustomer(sessionId, event, data) {
  const streams = customerStreams.get(sessionId);
  if (!streams) return;
  for (const res of streams) {
    try { sseWrite(res, event, data); } catch (_) { streams.delete(res); }
  }
  if (!streams.size) customerStreams.delete(sessionId);
}

function emitSession(sessionId) {
  const session = store.getSession(sessionId);
  if (!session) return;
  emitAdmin('session-updated', {
    id: session.id,
    status: session.status,
    assignedTo: session.assignedTo,
    updatedAt: session.updatedAt,
    messageCount: session.messages.length,
    lastMessage: session.messages.at(-1) || null
  });
}

function isAdmin(req) {
  const token = String(req.headers['x-admin-token'] || '');
  return adminTokens.has(token);
}

function ensureAdmin(req, res) {
  if (isAdmin(req)) return true;
  sendJson(res, 401, { error: 'Phiên đăng nhập admin không hợp lệ hoặc đã hết hạn.' });
  return false;
}

function productCardsByIds(ids, fallbackCandidates = []) {
  const selected = [];
  const seen = new Set();
  for (const id of ids || []) {
    const product = products.getProduct(id);
    if (product && !seen.has(product.id)) {
      seen.add(product.id);
      selected.push(product);
    }
  }
  return Array.isArray(ids) ? selected : fallbackCandidates.slice(0, 5);
}

function fallbackAnswer(message, candidates) {
  const exact = products.exactLookup(message);
  if (exact) {
    const product = exact.product;
    const variant = exact.variant;
    const variantText = variant
      ? ` Mã bạn nhập khớp với biến thể${variant.color ? ` màu ${variant.color}` : ''}${variant.size ? `, size ${variant.size}` : ''}.`
      : '';
    return {
      reply: `Mình đã tìm thấy “${product.name}”.${variantText} Bạn xem ảnh, giá, màu, size và đường dẫn chi tiết ở thẻ bên dưới nhé.`,
      products: [products.publicProduct(product, variant)]
    };
  }

  if (candidates.length) {
    return {
      reply: 'Mình đã tìm thấy một số sản phẩm gần với nhu cầu của bạn. Bạn có thể mở thẻ sản phẩm để xem màu, size, giá và chọn mua.',
      products: candidates.slice(0, 5)
    };
  }

  return {
    reply: 'Mình chưa tìm thấy sản phẩm phù hợp trong dữ liệu hiện tại. Bạn hãy gửi tên hoặc mã sản phẩm rõ hơn. Cần gặp nhân viên, hãy gõ “admin”.',
    products: []
  };
}

function matchPath(pathname, pattern) {
  const match = pathname.match(pattern);
  return match ? match.slice(1).map(decodeURIComponent) : null;
}

async function handleApi(req, res, url) {
  const { pathname, searchParams } = url;

  if (req.method === 'GET' && pathname === '/api/health') {
    return sendJson(res, 200, {
      ok: true,
      productCount: products.products.length,
      aiConfigured: ai.isConfigured(),
      localFirst: false,
      twoStageAi: true,
      aiAlwaysFinal: config.ai.alwaysFinal,
      routerModelConfigured: Boolean(config.ai.routerModel),
      chatModelConfigured: Boolean(config.ai.chatModel),
      aiMaxCandidates: config.ai.maxCandidates,
      shopDomain: config.shopDomain
    });
  }

  if (req.method === 'GET' && pathname === '/api/events/customer') {
    const sessionId = String(searchParams.get('sessionId') || '').trim();
    if (!sessionId) return sendJson(res, 400, { error: 'Thiếu sessionId.' });
    store.ensureSession(sessionId);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write(': connected\n\n');
    if (!customerStreams.has(sessionId)) customerStreams.set(sessionId, new Set());
    customerStreams.get(sessionId).add(res);
    req.on('close', () => {
      const streams = customerStreams.get(sessionId);
      if (!streams) return;
      streams.delete(res);
      if (!streams.size) customerStreams.delete(sessionId);
    });
    emitSession(sessionId);
    return;
  }

  if (req.method === 'GET' && pathname === '/api/events/admin') {
    const token = String(searchParams.get('token') || '');
    if (!adminTokens.has(token)) return sendJson(res, 401, { error: 'Phiên admin không hợp lệ.' });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write(': connected\n\n');
    adminStreams.add(res);
    req.on('close', () => adminStreams.delete(res));
    return;
  }

  if (req.method === 'GET' && pathname === '/api/products/search') {
    const query = String(searchParams.get('q') || '').trim();
    return sendJson(res, 200, { products: query ? products.search(query, 12) : [] });
  }

  let match = matchPath(pathname, /^\/api\/products\/([^/]+)$/);
  if (req.method === 'GET' && match) {
    const product = products.getProduct(match[0]);
    return product
      ? sendJson(res, 200, { product })
      : sendJson(res, 404, { error: 'Không tìm thấy sản phẩm.' });
  }

  match = matchPath(pathname, /^\/api\/sessions\/([^/]+)$/);
  if (req.method === 'GET' && match) {
    return sendJson(res, 200, { session: store.ensureSession(match[0]) });
  }

  if (req.method === 'POST' && pathname === '/api/chat') {
    const body = await readJson(req);
    const sessionId = String(body.sessionId || '').trim();
    const messageText = String(body.message || '').trim().slice(0, 3000);
    if (!sessionId || !messageText) {
      return sendJson(res, 400, { error: 'Thiếu sessionId hoặc nội dung tin nhắn.' });
    }

    const session = store.ensureSession(sessionId);
    const userMessage = store.addMessage(sessionId, 'user', messageText);
    emitAdmin('message-new', { sessionId, message: userMessage });
    emitSession(sessionId);

    const command = normalizeText(messageText);
    if (['admin', '/admin', 'gap admin', 'gap nhan vien'].includes(command)) {
      store.setSessionStatus(sessionId, 'waiting_admin');
      const replyText = 'Mình đã chuyển yêu cầu sang nhân viên. Bạn cứ để lại nội dung cần hỗ trợ tại đây, nhân viên sẽ trả lời trực tiếp trong cửa sổ chat này.';
      const replyMessage = store.addMessage(sessionId, 'assistant', replyText, { source: 'handoff' });
      emitCustomer(sessionId, 'chat-message', replyMessage);
      emitAdmin('admin-alert', { sessionId, message: 'Khách đang chờ nhân viên hỗ trợ.' });
      emitSession(sessionId);
      return sendJson(res, 200, { reply: replyText, products: [], sessionStatus: 'waiting_admin', messageId: replyMessage.id });
    }

    if (session.status === 'waiting_admin' || session.status === 'human') {
      return sendJson(res, 200, { reply: null, products: [], sessionStatus: session.status });
    }

    const history = session.messages.slice(0, -1);
    let responseData;
    let source = 'local-fallback';
    let routeMeta = null;
    let databaseCandidates = [];

    if (!ai.isConfigured()) {
      const route = ai.fallbackRoute(messageText, history, 'AI chưa được cấu hình.');
      const candidates = route.needDatabase
        ? products.queryByPlan(route, messageText, route.search.limit)
        : [];
      const localResult = ai.fallbackFinal(messageText, route, candidates, 'AI chưa được cấu hình.');
      responseData = {
        reply: localResult.reply || 'AI chưa được cấu hình. Mình đã tìm sản phẩm bằng dữ liệu local.',
        products: productCardsByIds(localResult.productIds, candidates),
        needsAdmin: false
      };
      source = 'local-no-ai';
    } else {
      try {
        // LẦN GỌI AI 1: chỉ nhận dạng ý định và xuất bộ lọc JSON, không được truy cập database.
        const route = await ai.route(messageText, history);
        routeMeta = {
          intent: route.intent,
          needDatabase: route.needDatabase,
          needFinalAi: route.needFinalAi,
          responseMode: route.responseMode
        };

        if (route.needsAdmin || route.intent === 'admin_handoff') {
          store.setSessionStatus(sessionId, 'waiting_admin');
          const replyText = 'Mình đã chuyển yêu cầu sang nhân viên. Bạn cứ để lại nội dung cần hỗ trợ tại đây, nhân viên sẽ trả lời trực tiếp trong cửa sổ chat này.';
          const replyMessage = store.addMessage(sessionId, 'assistant', replyText, {
            source: route.cached ? 'ai-router-cache-handoff' : 'ai-router-handoff',
            route: routeMeta
          });
          emitCustomer(sessionId, 'chat-message', replyMessage);
          emitAdmin('admin-alert', { sessionId, message: 'Khách đang chờ nhân viên hỗ trợ.' });
          emitSession(sessionId);
          return sendJson(res, 200, {
            reply: replyText,
            products: [],
            sessionStatus: 'waiting_admin',
            messageId: replyMessage.id,
            source: replyMessage.source
          });
        }

        if (route.responseMode === 'clarify' && route.clarificationQuestion) {
          const replyMessage = store.addMessage(sessionId, 'assistant', route.clarificationQuestion, {
            source: route.cached ? 'ai-router-cache-clarify' : 'ai-router-clarify',
            route: routeMeta
          });
          emitCustomer(sessionId, 'chat-message', replyMessage);
          emitAdmin('message-new', { sessionId, message: replyMessage });
          emitSession(sessionId);
          return sendJson(res, 200, {
            reply: route.clarificationQuestion,
            products: [],
            sessionStatus: session.status,
            messageId: replyMessage.id,
            source: replyMessage.source
          });
        }

        // DATABASE chỉ được truy vấn bằng code dựa trên JSON đã kiểm tra từ AI lần 1.
        const candidates = route.needDatabase
          ? products.queryByPlan(route, messageText, route.search.limit)
          : [];
        databaseCandidates = candidates;

        if (route.needFinalAi) {
          // LẦN GỌI AI 2: chỉ nhận kết quả database đã rút gọn và soạn câu trả lời cuối.
          const finalResult = await ai.answer(messageText, route, candidates, history);
          responseData = {
            reply: finalResult.reply,
            products: productCardsByIds(finalResult.productIds, candidates),
            needsAdmin: finalResult.needsAdmin
          };
          source = [
            route.cached ? 'ai-router-cache' : 'ai-router',
            route.needDatabase ? 'database-code' : 'no-database',
            finalResult.cached ? 'ai-final-cache' : 'ai-final'
          ].join('+');
        } else {
          responseData = {
            reply: route.clarificationQuestion || 'Bạn vui lòng cung cấp thêm thông tin để mình hỗ trợ chính xác hơn.',
            products: candidates,
            needsAdmin: false
          };
          source = `${route.cached ? 'ai-router-cache' : 'ai-router'}+code-response`;
        }
      } catch (error) {
        console.error('Lỗi luồng AI hai tầng:', error.message);
        const route = ai.fallbackRoute(messageText, history, error.message);
        const candidates = route.needDatabase
          ? products.queryByPlan(route, messageText, route.search.limit)
          : [];
        const localResult = ai.fallbackFinal(messageText, route, candidates, error.message);
        responseData = {
          reply: localResult.reply || 'AI đang tạm thời chưa kết nối. Mình đã thử tìm sản phẩm bằng dữ liệu local; bạn cũng có thể gõ “admin” để gặp nhân viên.',
          products: databaseCandidates.length
            ? databaseCandidates
            : productCardsByIds(localResult.productIds, candidates),
          needsAdmin: false
        };
        source = databaseCandidates.length ? 'database-after-ai-error' : 'local-after-ai-error';
      }
    }

    if (responseData.needsAdmin) responseData.reply += ' Bạn có thể gõ “admin” để gặp nhân viên.';
    const replyMessage = store.addMessage(sessionId, 'assistant', responseData.reply, {
      source,
      productIds: responseData.products.map((item) => item.id),
      route: routeMeta
    });
    emitCustomer(sessionId, 'chat-message', { ...replyMessage, products: responseData.products });
    emitAdmin('message-new', { sessionId, message: replyMessage });
    emitSession(sessionId);
    return sendJson(res, 200, {
      reply: responseData.reply,
      products: responseData.products,
      sessionStatus: store.getSession(sessionId).status,
      messageId: replyMessage.id,
      source
    });
  }

  if (req.method === 'POST' && pathname === '/api/orders') {
    try {
      const body = await readJson(req);
      const sessionId = String(body.sessionId || '').trim();
      const customer = body.customer || {};
      const requestedItems = Array.isArray(body.items) ? body.items : [];
      const name = String(customer.name || '').trim().slice(0, 120);
      const phone = String(customer.phone || '').trim().slice(0, 30);
      const address = String(customer.address || '').trim().slice(0, 300);
      const note = String(customer.note || '').trim().slice(0, 500);

      if (!name || !phone || !address) return sendJson(res, 400, { error: 'Vui lòng nhập họ tên, số điện thoại và địa chỉ.' });
      if (!requestedItems.length) return sendJson(res, 400, { error: 'Đơn hàng chưa có sản phẩm.' });

      const items = requestedItems.map((item) => {
        const found = products.getVariant(String(item.variantId || ''));
        const quantity = Math.max(1, Math.min(99, Number(item.quantity || 1)));
        if (!found) throw new Error(`Không tìm thấy biến thể ${item.variantId}.`);
        if (!found.variant.inStock) throw new Error(`${found.product.name} - biến thể đã hết hàng.`);
        return {
          productId: found.product.id,
          variantId: found.variant.id,
          sku: found.variant.sku,
          name: found.product.name,
          color: found.variant.color,
          size: found.variant.size,
          image: found.variant.image || found.product.images[0] || '',
          price: found.variant.price,
          quantity,
          lineTotal: found.variant.price * quantity,
          url: found.product.url
        };
      });

      const now = new Date();
      const datePart = now.toISOString().slice(0, 10).replace(/-/g, '');
      const order = {
        id: `GHS-${datePart}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`,
        sessionId,
        customer: { name, phone, address, note },
        items,
        total: items.reduce((sum, item) => sum + item.lineTotal, 0),
        status: 'new',
        createdAt: now.toISOString(),
        updatedAt: now.toISOString()
      };
      store.createOrder(order);
      const confirmation = store.addMessage(sessionId, 'assistant', `Đã lưu đơn nháp ${order.id}. Nhân viên sẽ kiểm tra và liên hệ với bạn qua số ${phone}.`, { source: 'order', orderId: order.id });
      emitCustomer(sessionId, 'chat-message', confirmation);
      emitAdmin('order-new', order);
      emitSession(sessionId);
      return sendJson(res, 201, { order });
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
  }

  if (req.method === 'POST' && pathname === '/api/admin/login') {
    const body = await readJson(req);
    if (String(body.password || '') !== config.adminPassword) return sendJson(res, 401, { error: 'Mật khẩu không đúng.' });
    const token = crypto.randomBytes(32).toString('hex');
    adminTokens.add(token);
    return sendJson(res, 200, { ok: true, token });
  }

  if (req.method === 'POST' && pathname === '/api/admin/logout') {
    if (!ensureAdmin(req, res)) return;
    adminTokens.delete(String(req.headers['x-admin-token'] || ''));
    return sendJson(res, 200, { ok: true });
  }

  if (pathname.startsWith('/api/admin/') && !ensureAdmin(req, res)) return;

  if (req.method === 'GET' && pathname === '/api/admin/sessions') {
    return sendJson(res, 200, { sessions: store.listSessions() });
  }

  // Endpoint ổn định cho giao diện admin: truyền sessionId bằng query string.
  // Giữ lại endpoint /api/admin/sessions/:id bên dưới để tương thích bản cũ.
  if (req.method === 'GET' && pathname === '/api/admin/session') {
    const sessionId = String(searchParams.get('sessionId') || '').trim();
    if (!sessionId) return sendJson(res, 400, { error: 'Thiếu sessionId.' });
    const session = store.getSession(sessionId);
    return session
      ? sendJson(res, 200, { session })
      : sendJson(res, 404, { error: 'Không tìm thấy cuộc trò chuyện.' });
  }

  match = matchPath(pathname, /^\/api\/admin\/sessions\/([^/]+)$/);
  if (req.method === 'GET' && match) {
    const session = store.getSession(match[0]);
    return session
      ? sendJson(res, 200, { session })
      : sendJson(res, 404, { error: 'Không tìm thấy cuộc trò chuyện.' });
  }

  match = matchPath(pathname, /^\/api\/admin\/sessions\/([^/]+)\/claim$/);
  if (req.method === 'POST' && match) {
    const body = await readJson(req);
    const sessionId = match[0];
    const adminName = String(body.adminName || 'Nhân viên GHS').trim().slice(0, 80);
    store.setSessionStatus(sessionId, 'human', adminName);
    const message = store.addMessage(sessionId, 'admin', `${adminName} đã tham gia cuộc trò chuyện.`, { systemNotice: true });
    emitCustomer(sessionId, 'chat-message', message);
    emitAdmin('message-new', { sessionId, message });
    emitSession(sessionId);
    return sendJson(res, 200, { session: store.getSession(sessionId) });
  }

  match = matchPath(pathname, /^\/api\/admin\/sessions\/([^/]+)\/release$/);
  if (req.method === 'POST' && match) {
    const sessionId = match[0];
    store.setSessionStatus(sessionId, 'bot');
    const message = store.addMessage(sessionId, 'assistant', 'Cuộc trò chuyện đã được chuyển lại cho trợ lý AI. Bạn vẫn có thể gõ “admin” khi cần gặp nhân viên.', { source: 'handoff' });
    emitCustomer(sessionId, 'chat-message', message);
    emitAdmin('message-new', { sessionId, message });
    emitSession(sessionId);
    return sendJson(res, 200, { session: store.getSession(sessionId) });
  }

  match = matchPath(pathname, /^\/api\/admin\/sessions\/([^/]+)\/messages$/);
  if (req.method === 'POST' && match) {
    const body = await readJson(req);
    const text = String(body.message || '').trim().slice(0, 3000);
    const adminName = String(body.adminName || 'Nhân viên GHS').trim().slice(0, 80);
    if (!text) return sendJson(res, 400, { error: 'Nội dung tin nhắn đang trống.' });
    const sessionId = match[0];
    store.setSessionStatus(sessionId, 'human', adminName);
    const message = store.addMessage(sessionId, 'admin', text, { adminName });
    emitCustomer(sessionId, 'chat-message', message);
    emitAdmin('message-new', { sessionId, message });
    emitSession(sessionId);
    return sendJson(res, 200, { message });
  }

  if (req.method === 'GET' && pathname === '/api/admin/orders') {
    return sendJson(res, 200, { orders: store.listOrders() });
  }

  match = matchPath(pathname, /^\/api\/admin\/orders\/([^/]+)$/);
  if (req.method === 'PATCH' && match) {
    const body = await readJson(req);
    const allowed = ['new', 'contacted', 'confirmed', 'cancelled'];
    const status = String(body.status || '');
    if (!allowed.includes(status)) return sendJson(res, 400, { error: 'Trạng thái không hợp lệ.' });
    const order = store.updateOrderStatus(match[0], status);
    return order
      ? sendJson(res, 200, { order })
      : sendJson(res, 404, { error: 'Không tìm thấy đơn.' });
  }

  if (req.method === 'POST' && pathname === '/api/admin/ai-test') {
    try {
      return sendJson(res, 200, await ai.testConnection());
    } catch (error) {
      return sendJson(res, 502, { ok: false, message: error.message });
    }
  }

  return sendJson(res, 404, { error: 'Không tìm thấy API.' });
}

function serveStatic(req, res, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.resolve(publicDir, `.${requested}`);
  if (!filePath.startsWith(publicDir)) return sendText(res, 403, 'Forbidden');
  fs.stat(filePath, (error, stat) => {
    if (error || !stat.isFile()) return sendText(res, 404, 'Không tìm thấy trang.');
    res.writeHead(200, {
      'Content-Type': mimeTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return serveStatic(req, res, url.pathname);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) sendJson(res, 500, { error: error.message || 'Máy chủ gặp lỗi.' });
    else res.end();
  }
});

setInterval(() => {
  for (const streams of customerStreams.values()) {
    for (const res of streams) {
      try { res.write(': keepalive\n\n'); } catch (_) {}
    }
  }
  for (const res of adminStreams) {
    try { res.write(': keepalive\n\n'); } catch (_) {}
  }
}, 25_000).unref();

server.listen(config.port, '0.0.0.0', () => {
  console.log(`Chatbot: http://localhost:${config.port}`);
  console.log(`Admin:   http://localhost:${config.port}/admin.html`);
  console.log(`AI:      ${ai.isConfigured() ? 'Đã cấu hình 2 tầng (Router → Database code → Final)' : 'Chưa cấu hình - đang dùng tìm kiếm local dự phòng'}`);
});
