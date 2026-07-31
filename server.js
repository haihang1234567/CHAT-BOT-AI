const loadEnv = require('./src/env');
loadEnv();

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const config = require('./src/config');
const JsonStore = require('./src/store');
const { ProductService, normalizeText } = require('./src/productService');
const { EmbeddingService } = require('./src/embeddingService');
const HaravanService = require('./src/haravanService');
const AiService = require('./src/aiService');
const LocalKnowledgeService = require('./src/localKnowledgeService');
const WebKnowledgeService = require('./src/webKnowledgeService');
const KnowledgeService = require('./src/knowledgeService');

const store = new JsonStore(config.storePath);
const embedding = new EmbeddingService(config.embedding);
const loadCsvAtStart = config.productSource === 'csv'
  || (config.haravan.fallbackToCsv && fs.existsSync(config.productCsvPath));
const products = new ProductService(config.productCsvPath, config.shopDomain, {
  loadCsv: loadCsvAtStart,
  embeddingService: embedding
});
const haravan = new HaravanService(config.haravan, products);
const ai = new AiService(config.ai, products);
const localKnowledge = new LocalKnowledgeService(config.knowledge);
const webKnowledge = new WebKnowledgeService(config.knowledge);
const knowledge = new KnowledgeService(config.knowledge, localKnowledge, webKnowledge);
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

function productPageSize() {
  return Math.max(1, Math.min(5, Number(config.ai.chatProductPageSize || 3)));
}

async function productPage(route, fallbackQuery = '', excludedIds = []) {
  if (!route?.needDatabase || !route?.showProducts) {
    return { items: [], hasMore: false };
  }
  const pageSize = productPageSize();
  const excluded = [...new Set([
    ...(route?.search?.excludeProductIds || []),
    ...(excludedIds || [])
  ].map(String).filter(Boolean))];
  const pageRoute = {
    ...route,
    search: {
      ...(route.search || {}),
      excludeProductIds: excluded,
      limit: pageSize + 1
    }
  };
  const matches = await products.hybridQueryByPlan(pageRoute, fallbackQuery, pageSize + 1);
  return {
    items: matches.slice(0, pageSize),
    hasMore: matches.length > pageSize
  };
}

let embeddingSyncPromise = null;
async function syncProductEmbeddings(options = {}) {
  if (!config.embedding.autoSync || !embedding.isConfigured()) {
    return { built: 0, reused: 0, total: embedding.entries.size, skipped: true };
  }
  if (embeddingSyncPromise) return embeddingSyncPromise;
  embeddingSyncPromise = embedding.syncProducts(products.products, {
    force: Boolean(options.force),
    onProgress: ({ built, pending, total }) => {
      console.log(`[EMBEDDINGS] Đã tạo ${built}/${pending} vector cần cập nhật (${total} sản phẩm).`);
    }
  }).then((stats) => {
    console.log(`[EMBEDDINGS] Hoàn tất: ${stats.built} mới, ${stats.reused} dùng lại, ${stats.total} tổng.`);
    return stats;
  }).catch((error) => {
    console.error(`[EMBEDDINGS] Đồng bộ thất bại, chatbot vẫn dùng tìm kiếm từ khóa: ${error.message}`);
    return { built: 0, reused: 0, total: embedding.entries.size, skipped: true, error: error.message };
  }).finally(() => {
    embeddingSyncPromise = null;
  });
  return embeddingSyncPromise;
}

function loadMoreSuggestions(suggestions = [], hasMore = false) {
  const remaining = (Array.isArray(suggestions) ? suggestions : [])
    .filter((item) => item?.action !== 'load_more_products')
    .slice(0, hasMore ? 2 : 3);
  return hasMore
    ? [{
        label: 'Xem thêm sản phẩm',
        action: 'load_more_products'
      }, ...remaining]
    : remaining;
}

function latestProductPagination(session) {
  for (let index = (session?.messages || []).length - 1; index >= 0; index -= 1) {
    const message = session.messages[index];
    if (
      message?.role === 'assistant'
      && message?.pagination
      && message?.route?.search
    ) return message;
  }
  return null;
}

function routeSource(route, suffix = '') {
  const base = route?._source || 'ai-router';
  return `${base}${route?.cached ? '-cache' : ''}${suffix ? `-${suffix}` : ''}`;
}

function routeMetadata(route) {
  if (!route) return null;
  return {
    intent: route.intent,
    needDatabase: route.needDatabase,
    needWeb: route.needWeb,
    needFinalAi: route.needFinalAi,
    showProducts: route.showProducts,
    responseMode: route.responseMode,
    clarificationQuestion: route.clarificationQuestion || '',
    consultation: route.consultation || null,
    corrections: route.corrections || [],
    search: route.search || {}
  };
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
      catalog: products.status(),
      productSource: config.productSource,
      haravan: haravan.status(),
      aiConfigured: ai.isConfigured(),
      localFirst: false,
      twoStageAi: true,
      aiAlwaysFinal: config.ai.alwaysFinal,
      routerModelConfigured: Boolean(config.ai.routerModel),
      chatModelConfigured: Boolean(config.ai.chatModel),
      aiMaxCandidates: config.ai.maxCandidates,
      embeddings: embedding.status(),
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

  if (req.method === 'POST' && pathname === '/api/chat/products/more') {
    const body = await readJson(req);
    const sessionId = String(body.sessionId || '').trim();
    if (!sessionId) return sendJson(res, 400, { error: 'Thiếu sessionId.' });

    const session = store.ensureSession(sessionId);
    if (session.status === 'waiting_admin' || session.status === 'human') {
      return sendJson(res, 409, { error: 'Cuộc trò chuyện đang do nhân viên hỗ trợ.' });
    }

    const previous = latestProductPagination(session);
    if (!previous?.pagination?.hasMore) {
      return sendJson(res, 409, { error: 'Đã hiển thị tất cả sản phẩm phù hợp.' });
    }

    const shownIds = [...new Set(
      (previous.pagination.shownProductIds || []).map(String).filter(Boolean)
    )];
    const nextPage = await productPage(
      {
        ...previous.route,
        needDatabase: true,
        showProducts: true
      },
      previous.route?.search?.query || '',
      shownIds
    );
    const nextIds = nextPage.items.map((item) => String(item.id));
    const allShownIds = [...new Set([...shownIds, ...nextIds])];
    const pagination = {
      pageSize: productPageSize(),
      shownProductIds: allShownIds,
      hasMore: nextPage.hasMore
    };
    const route = {
      ...previous.route,
      search: {
        ...(previous.route.search || {}),
        excludeProductIds: allShownIds,
        limit: productPageSize()
      }
    };
    const suggestions = loadMoreSuggestions(previous.suggestions, pagination.hasMore);
    const userMessage = store.addMessage(sessionId, 'user', 'Xem thêm sản phẩm', {
      source: 'product-pagination-action'
    });
    emitAdmin('message-new', { sessionId, message: userMessage });

    const replyText = nextPage.items.length
      ? pagination.hasMore
        ? `Mình gửi thêm ${nextPage.items.length} sản phẩm phù hợp. Bạn có thể tiếp tục bấm “Xem thêm sản phẩm”.`
        : `Mình gửi ${nextPage.items.length} sản phẩm phù hợp còn lại. Đây là toàn bộ kết quả theo tiêu chí hiện tại.`
      : 'Đã hiển thị tất cả sản phẩm phù hợp theo tiêu chí hiện tại.';
    const replyMessage = store.addMessage(sessionId, 'assistant', replyText, {
      source: 'product-pagination-code',
      productIds: nextIds,
      contextProductIds: nextIds,
      suggestions,
      sources: [],
      route,
      pagination: {
        ...pagination,
        hasMore: Boolean(nextPage.items.length && pagination.hasMore)
      }
    });
    emitCustomer(sessionId, 'chat-message', { ...replyMessage, products: nextPage.items });
    emitAdmin('message-new', { sessionId, message: replyMessage });
    emitSession(sessionId);
    return sendJson(res, 200, {
      reply: replyText,
      products: nextPage.items,
      suggestions,
      sources: [],
      sessionStatus: session.status,
      messageId: replyMessage.id,
      source: replyMessage.source,
      hasMore: replyMessage.pagination.hasMore
    });
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
    let pageHasMore = false;

    if (!ai.isConfigured()) {
      const route = ai.fallbackRoute(messageText, history, 'AI chưa được cấu hình.');
      routeMeta = routeMetadata(route);
      const page = await productPage(route, messageText);
      const candidates = page.items;
      pageHasMore = page.hasMore;
      const localResult = ai.fallbackFinal(messageText, route, candidates, 'AI chưa được cấu hình.');
      const selectedProducts = productCardsByIds(localResult.productIds, candidates);
      responseData = {
        reply: localResult.reply,
        products: route.showProducts ? selectedProducts : [],
        contextProductIds: selectedProducts.map((item) => item.id),
        suggestions: localResult.suggestions || [],
        sources: [],
        needsAdmin: false
      };
      source = 'local-no-ai';
    } else {
      try {
        // LẦN GỌI AI 1: chỉ nhận dạng ý định và xuất bộ lọc JSON, không được truy cập database.
        const route = await ai.route(messageText, history);
        routeMeta = routeMetadata(route);

        if (route.needsAdmin || route.intent === 'admin_handoff') {
          store.setSessionStatus(sessionId, 'waiting_admin');
          const replyText = 'Mình đã chuyển yêu cầu sang nhân viên. Bạn cứ để lại nội dung cần hỗ trợ tại đây, nhân viên sẽ trả lời trực tiếp trong cửa sổ chat này.';
          const replyMessage = store.addMessage(sessionId, 'assistant', replyText, {
            source: routeSource(route, 'handoff'),
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
            source: routeSource(route, 'clarify'),
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

        if (route.intent === 'general_question' || route.needWeb) {
          // Kiến thức: tìm nguồn chính thống trước, sau đó AI chỉ tổng hợp từ các nguồn đã duyệt.
          const research = await knowledge.search(route.webQuery || messageText, {
            originalQuestion: messageText
          });
          const finalResult = await ai.answerKnowledge(
            messageText,
            route,
            research.sources,
            history,
            { purpose: 'knowledge-final' }
          );
          responseData = {
            reply: finalResult.reply,
            products: [],
            contextProductIds: [],
            suggestions: finalResult.suggestions || [],
            sources: finalResult.sources || [],
            needsAdmin: finalResult.needsAdmin
          };
          source = [
            routeSource(route),
            research.provider === 'local'
              ? 'knowledge-local'
              : research.cached ? 'web-cache' : 'web-official',
            finalResult.cached ? 'knowledge-cache' : finalResult._source
          ].join('+');
        } else {
          // Sản phẩm: AI chỉ xuất bộ lọc JSON; code truy vấn Haravan và dựng thẻ/biến thể.
          const page = await productPage(route, messageText);
          const candidates = page.items;
          pageHasMore = page.hasMore;
          databaseCandidates = candidates;

          if (route.needFinalAi) {
          // LẦN GỌI AI 2: chỉ nhận kết quả database đã rút gọn và soạn câu trả lời cuối.
            const finalResult = await ai.answer(messageText, route, candidates, history);
            const selectedProducts = productCardsByIds(finalResult.productIds, candidates);
            responseData = {
              reply: finalResult.reply,
              products: route.showProducts ? selectedProducts : [],
              contextProductIds: selectedProducts.map((item) => item.id),
              suggestions: finalResult.suggestions || [],
              sources: [],
              needsAdmin: finalResult.needsAdmin
            };
            source = [
              routeSource(route),
              route.needDatabase ? 'database-code' : 'no-database',
              finalResult.cached ? 'ai-final-cache' : 'ai-final'
            ].join('+');
          } else {
            const localResult = ai.fallbackFinal(messageText, route, candidates);
            responseData = {
              reply: localResult.reply,
              products: route.showProducts ? productCardsByIds(localResult.productIds, candidates) : [],
              contextProductIds: localResult.productIds || candidates.map((item) => item.id),
              suggestions: localResult.suggestions || [],
              sources: [],
              needsAdmin: false
            };
            source = `${routeSource(route)}+haravan-code-response`;
          }
        }
      } catch (error) {
        console.error('Lỗi luồng AI hai tầng:', error.message);
        const selectedProducts = databaseCandidates;
        responseData = {
          reply: selectedProducts.length
            ? 'Mình đã lọc được dữ liệu sản phẩm nhưng chưa tạo được câu trả lời hoàn chỉnh. Bạn xem các thẻ bên dưới hoặc gõ “admin” để nhân viên hỗ trợ.'
            : 'Mình chưa thể phân tích hoặc kiểm chứng câu hỏi lúc này nên sẽ không tự suy đoán. Bạn thử lại sau hoặc gõ “admin” để nhân viên hỗ trợ.',
          products: selectedProducts,
          contextProductIds: selectedProducts.map((item) => item.id),
          suggestions: [],
          sources: [],
          needsAdmin: false
        };
        source = databaseCandidates.length ? 'database-after-ai-error' : 'local-after-ai-error';
      }
    }

    if (responseData.needsAdmin) responseData.reply += ' Bạn có thể gõ “admin” để gặp nhân viên.';
    const displayedProductIds = responseData.products.map((item) => String(item.id));
    const pagination = routeMeta && displayedProductIds.length
      ? {
          pageSize: productPageSize(),
          shownProductIds: displayedProductIds,
          hasMore: Boolean(
            pageHasMore
            || databaseCandidates.some((item) => !displayedProductIds.includes(String(item.id)))
          )
        }
      : null;
    responseData.suggestions = loadMoreSuggestions(
      responseData.suggestions,
      Boolean(pagination?.hasMore)
    );
    const replyMessage = store.addMessage(sessionId, 'assistant', responseData.reply, {
      source,
      productIds: displayedProductIds,
      contextProductIds: responseData.contextProductIds || responseData.products.map((item) => item.id),
      suggestions: responseData.suggestions || [],
      sources: responseData.sources || [],
      route: routeMeta,
      pagination
    });
    emitCustomer(sessionId, 'chat-message', { ...replyMessage, products: responseData.products });
    emitAdmin('message-new', { sessionId, message: replyMessage });
    emitSession(sessionId);
    return sendJson(res, 200, {
      reply: responseData.reply,
      products: responseData.products,
      suggestions: responseData.suggestions || [],
      sources: responseData.sources || [],
      sessionStatus: store.getSession(sessionId).status,
      messageId: replyMessage.id,
      source,
      hasMore: Boolean(pagination?.hasMore)
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

  if (req.method === 'GET' && pathname === '/api/admin/catalog-status') {
    return sendJson(res, 200, {
      source: config.productSource,
      catalog: products.status(),
      haravan: haravan.status()
    });
  }

  if (req.method === 'GET' && pathname === '/api/admin/products/search') {
    const query = String(searchParams.get('q') || '').trim().slice(0, 200);
    const requestedLimit = Number(searchParams.get('limit') || 12);
    const limit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(20, requestedLimit))
      : 12;
    return sendJson(res, 200, {
      query,
      products: query ? products.search(query, limit) : []
    });
  }

  if (req.method === 'POST' && pathname === '/api/admin/catalog-sync') {
    if (config.productSource !== 'haravan') {
      return sendJson(res, 400, { error: 'PRODUCT_SOURCE hiện không đặt là haravan.' });
    }
    if (!haravan.isConfigured()) {
      return sendJson(res, 400, { error: 'Chưa cấu hình HARAVAN_ACCESS_TOKEN.' });
    }
    try {
      const stats = await haravan.sync();
      const embeddingStats = await syncProductEmbeddings();
      return sendJson(res, 200, {
        ok: true,
        message: 'Đồng bộ Haravan thành công.',
        stats,
        embeddings: embeddingStats,
        catalog: products.status()
      });
    } catch (error) {
      return sendJson(res, 502, {
        ok: false,
        error: error.message,
        catalog: products.status()
      });
    }
  }

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
    const requestedProductIds = Array.isArray(body.productIds)
      ? body.productIds.map(String).slice(0, 5)
      : [];
    const selectedProducts = productCardsByIds(requestedProductIds);
    const text = String(body.message || '').trim().slice(0, 3000)
      || (selectedProducts.length ? 'Mình gửi bạn một số sản phẩm phù hợp để tham khảo nhé.' : '');
    const adminName = String(body.adminName || 'Nhân viên GHS').trim().slice(0, 80);
    if (!text && !selectedProducts.length) {
      return sendJson(res, 400, { error: 'Hãy nhập tin nhắn hoặc chọn ít nhất một sản phẩm.' });
    }
    if (requestedProductIds.length && !selectedProducts.length) {
      return sendJson(res, 400, { error: 'Không tìm thấy sản phẩm đã chọn trong kho hiện tại.' });
    }
    const sessionId = match[0];
    store.setSessionStatus(sessionId, 'human', adminName);
    const message = store.addMessage(sessionId, 'admin', text, {
      adminName,
      productIds: selectedProducts.map((product) => product.id)
    });
    const deliveredMessage = { ...message, products: selectedProducts };
    emitCustomer(sessionId, 'chat-message', deliveredMessage);
    emitAdmin('message-new', { sessionId, message: deliveredMessage });
    emitSession(sessionId);
    return sendJson(res, 200, { message: deliveredMessage });
  }

  match = matchPath(pathname, /^\/api\/admin\/sessions\/([^/]+)\/ai-suggestion$/);
  if (req.method === 'POST' && match) {
    if (!ai.isConfigured()) {
      return sendJson(res, 400, {
        error: 'AI chưa được cấu hình. Hãy kiểm tra token và model trong Environment.'
      });
    }

    const body = await readJson(req);
    const sessionId = match[0];
    const session = store.getSession(sessionId);
    if (!session) return sendJson(res, 404, { error: 'Không tìm thấy cuộc trò chuyện.' });
    if (session.status !== 'human') {
      return sendJson(res, 409, {
        error: 'Hãy bấm “Nhận hỗ trợ” trước khi yêu cầu AI gợi ý câu trả lời.'
      });
    }

    const requestedMessageId = String(body.messageId || '').trim();
    let messageIndex = requestedMessageId
      ? session.messages.findIndex((message) => message.id === requestedMessageId && message.role === 'user')
      : -1;
    if (requestedMessageId && messageIndex < 0) {
      return sendJson(res, 404, { error: 'Không tìm thấy câu hỏi của khách đã chọn.' });
    }
    if (messageIndex < 0) {
      for (let index = session.messages.length - 1; index >= 0; index -= 1) {
        if (session.messages[index].role === 'user') {
          messageIndex = index;
          break;
        }
      }
    }
    if (messageIndex < 0) {
      return sendJson(res, 400, { error: 'Cuộc trò chuyện chưa có câu hỏi nào của khách.' });
    }

    const customerMessage = session.messages[messageIndex];
    const history = session.messages.slice(0, messageIndex);

    try {
      const route = await ai.route(customerMessage.text, history, { forceAi: true });
      if (!route) throw new Error('AI Router không trả về kế hoạch tư vấn.');

      if (route.responseMode === 'clarify' && route.clarificationQuestion) {
        return sendJson(res, 200, {
          messageId: customerMessage.id,
          question: customerMessage.text,
          suggestion: route.clarificationQuestion,
          products: [],
          source: routeSource(route, 'clarify')
        });
      }

      let candidates = [];
      let finalResult;
      if (route.intent === 'general_question' || route.needWeb) {
        const research = await knowledge.search(route.webQuery || customerMessage.text, {
          originalQuestion: customerMessage.text
        });
        finalResult = await ai.answerKnowledge(
          customerMessage.text,
          route,
          research.sources,
          history,
          { purpose: 'admin-knowledge-suggestion' }
        );
      } else {
        candidates = route.needDatabase
          ? await products.hybridQueryByPlan(route, customerMessage.text, route.search.limit)
          : [];
        finalResult = route.needFinalAi
          ? await ai.answer(customerMessage.text, route, candidates, history, { purpose: 'admin-suggestion' })
          : ai.fallbackFinal(customerMessage.text, route, candidates);
      }
      if (!finalResult?.reply) throw new Error('AI không tạo được câu trả lời gợi ý.');

      return sendJson(res, 200, {
        messageId: customerMessage.id,
        question: customerMessage.text,
        suggestion: finalResult.reply,
        products: productCardsByIds(finalResult.productIds, candidates),
        sources: finalResult.sources || [],
        source: [
          routeSource(route),
          finalResult.cached ? 'ai-final-cache' : 'ai-final'
        ].join('+')
      });
    } catch (error) {
      console.error('Lỗi tạo gợi ý trả lời cho Admin:', error.message);
      return sendJson(res, 502, { error: `Không tạo được gợi ý: ${error.message}` });
    }
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
  console.log(`Dữ liệu: ${config.productSource === 'haravan' ? 'Haravan API' : 'CSV local'}`);
  console.log(`AI:      ${ai.isConfigured() ? 'Đã cấu hình 2 tầng (Router → Database code → Final)' : 'Chưa cấu hình - đang dùng tìm kiếm local dự phòng'}`);
  console.log(`Vector:  ${embedding.isConfigured() ? `${config.embedding.model} (${embedding.entries.size} vector đã nạp)` : 'Chưa cấu hình VOYAGE_API_KEY'}`);

  if (config.productSource === 'haravan') {
    if (!haravan.isConfigured()) {
      console.error('Chưa có HARAVAN_ACCESS_TOKEN; chatbot đang giữ dữ liệu CSV dự phòng nếu có.');
      syncProductEmbeddings();
      return;
    }
    haravan.sync()
      .then(() => syncProductEmbeddings())
      .catch((error) => {
        console.error(`Đồng bộ Haravan ban đầu thất bại: ${error.message}`);
        console.error('Chatbot tiếp tục dùng dữ liệu đang có và sẽ tự thử lại.');
      })
      .finally(() => {
        haravan.startAutoSync(
          (error) => {
            console.error(`Đồng bộ Haravan định kỳ thất bại: ${error.message}`);
          },
          () => syncProductEmbeddings()
        );
      });
  } else {
    syncProductEmbeddings();
  }
});
