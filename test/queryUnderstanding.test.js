const test = require('node:test');
const assert = require('node:assert/strict');

const AiService = require('../src/aiService');
const { ProductService, canonicalSearchText } = require('../src/productService');

function variant(id, size = '') {
  return {
    id,
    sku: `${id}-SKU`,
    size,
    quantity: 5,
    inStock: true,
    price: 1000000
  };
}

function createServices() {
  const products = new ProductService('', 'https://shop.example', { loadCsv: false });
  products.replaceProducts([
    {
      id: 'pickle-shoe',
      name: 'Giày Pickleball Diadora',
      type: 'Giày Pickleball',
      tags: 'pickleball, giày',
      images: [],
      variants: [variant('pickle-shoe-v1')]
    },
    {
      id: 'pickle-racket',
      name: 'Vợt Pickleball Promax',
      type: 'Vợt Pickleball',
      tags: 'pickleball, vợt',
      images: [],
      variants: [variant('pickle-racket-v1')]
    },
    {
      id: 'football-shoe',
      name: 'Giày Bóng Đá Mizuno TF',
      type: 'Giày Bóng Đá',
      tags: 'bóng đá, sân 7, TF',
      images: [],
      variants: [variant('football-shoe-v1', '4.5')]
    },
    {
      id: 'badminton-shoe',
      name: 'Giày Cầu Lông Mizuno Wave Claw',
      type: 'Giày Cầu Lông',
      tags: 'cầu lông, indoor',
      images: [],
      variants: [variant('badminton-shoe-v1', '4.5')]
    },
    {
      id: 'running-shoe',
      name: 'Giày Chạy Bộ Mizuno Wave Rider',
      type: 'Giày Chạy Bộ',
      tags: 'chạy bộ, running',
      images: [],
      variants: [variant('running-shoe-v1', '4.5')]
    }
  ]);

  const ai = new AiService({
    alwaysFinal: true,
    routerAlways: true,
    productFinalEnabled: false,
    maxCandidates: 5,
    routerHistoryMessages: 4,
    routerHistoryChars: 350
  }, products);
  return { ai, products };
}

test('hiểu “giày pick” là giày pickleball, không phải vợt', () => {
  const { ai, products } = createServices();

  for (const message of ['có giày pick không', 'giày pickleball', 'tìm shoes pickleball']) {
    const route = ai.fallbackRoute(message);
    const results = products.queryByPlan(route, message, 5);

    assert.deepEqual(route.search.categories, ['pickleball']);
    assert.equal(route.search.requirements.some((group) => group.label === 'Loại sản phẩm: Giày'), true);
    assert.deepEqual(results.map((product) => product.id), ['pickle-shoe']);
  }
});

test('hiểu “vợt pick” là vợt pickleball và không trả giày', () => {
  const { ai, products } = createServices();
  const message = 'có vợt pick không';
  const route = ai.fallbackRoute(message);
  const results = products.queryByPlan(route, message, 5);

  assert.deepEqual(route.search.categories, ['pickleball']);
  assert.equal(route.search.requirements.some((group) => group.label === 'Loại sản phẩm: Vợt'), true);
  assert.deepEqual(results.map((product) => product.id), ['pickle-racket']);
});

test('code loại bỏ phân tích AI mâu thuẫn với loại sản phẩm khách hỏi', () => {
  const { ai, products } = createServices();
  const message = 'có giày pick không';
  const wrongAiRoute = ai.normalizeRoute({
    intent: 'search_product',
    needDatabase: true,
    needFinalAi: true,
    showProducts: true,
    search: {
      query: message,
      categories: ['vợt pickleball'],
      requirements: [{ label: 'Loại sản phẩm', terms: ['vợt'], scope: 'identity' }]
    }
  }, message);

  const route = ai.mergeCodeRules(wrongAiRoute, message);
  const results = products.queryByPlan(route, message, 5);

  assert.equal(route.search.categories.includes('vợt pickleball'), false);
  assert.equal(route.search.requirements.some((group) => canonicalSearchText(group.terms.join(' ')) === 'vot'), false);
  assert.deepEqual(results.map((product) => product.id), ['pickle-shoe']);
});

test('câu quá mơ hồ thì hỏi lại và không tự hiện sản phẩm theo lịch sử', () => {
  const { ai, products } = createServices();
  const message = 'giày đi';
  const route = ai.fallbackRoute(message, [{
    role: 'assistant',
    text: 'Mình vừa giới thiệu giày pickleball.',
    contextProductIds: ['pickle-shoe']
  }]);
  const results = products.queryByPlan(route, message, 5);
  const answer = ai.fallbackFinal(message, route, results);

  assert.equal(route.responseMode, 'clarify');
  assert.equal(route.showProducts, false);
  assert.match(route.clarificationQuestion, /bộ môn hoặc nhu cầu nào/i);
  assert.deepEqual(answer.productIds, []);
  assert.equal(answer.reply, route.clarificationQuestion);
});

test('hiểu cách hỏi tắt “giày sân 7” và loại giày FG sân 11', () => {
  const { ai, products } = createServices();
  const message = 'giày sân 7 dưới 2 triệu';
  const route = ai.fallbackRoute(message);
  const results = products.queryByPlan(route, message, 5);

  assert.deepEqual(route.search.categories, ['bong da']);
  assert.equal(route.search.requirements.some((group) => /sân 5\/7/i.test(group.label)), true);
  assert.deepEqual(route.search.excludeTerms, ['fg', 'sg']);
  assert.deepEqual(results.map((product) => product.id), ['football-shoe']);
});

test('AI phân tích nhu cầu TF thành bộ lọc cấu trúc rồi code không trộn sai môn', async () => {
  const { ai, products } = createServices();
  const message = 'mizuno TF size 4.5';
  Object.assign(ai.config, {
    baseUrl: 'https://ai.example',
    token: 'test-token',
    routerModel: 'test-haiku',
    chatModel: 'test-haiku',
    routerMaxTokens: 220,
    cacheTtlMs: 60000
  });
  let calls = 0;
  ai.call = async () => {
    calls += 1;
    return JSON.stringify({
      intent: 'search_product',
      needDatabase: true,
      needWeb: false,
      showProducts: true,
      responseMode: 'brief',
      search: {
        query: message,
        brands: ['mizuno'],
        categories: ['bóng đá'],
        sizes: ['4.5'],
        customerNeeds: ['Giày bóng đá Mizuno đế TF size 4.5'],
        requirements: [
          { label: 'Đúng bộ môn bóng đá', terms: ['giày bóng đá'], scope: 'identity' },
          { label: 'Đúng loại đế TF', terms: ['TF'], scope: 'identity' }
        ],
        excludeTerms: [],
        inStockOnly: false,
        limit: 3
      }
    });
  };
  const route = await ai.route(message);
  const results = products.queryByPlan(route, message, 5);

  assert.equal(calls, 1);
  assert.deepEqual(route.search.categories, ['bóng đá']);
  assert.equal(route.needFinalAi, false);
  assert.equal(route.search.requirements.some((group) => (
    group.scope === 'identity'
    && group.terms.length === 1
    && canonicalSearchText(group.terms[0]) === 'tf'
  )), true);
  assert.deepEqual(results.map((product) => product.id), ['football-shoe']);
});

test('khi AI yêu cầu TF sai size, code không thay bằng sản phẩm môn khác', () => {
  const { ai, products } = createServices();
  const message = 'mizuno TF size 6.0';
  const route = ai.normalizeRoute({
    intent: 'search_product',
    needDatabase: true,
    showProducts: true,
    search: {
      query: message,
      brands: ['mizuno'],
      categories: ['bóng đá'],
      sizes: ['6.0'],
      customerNeeds: ['Giày bóng đá Mizuno đế TF size 6.0'],
      requirements: [
        { label: 'Đúng bộ môn bóng đá', terms: ['giày bóng đá'], scope: 'identity' },
        { label: 'Đúng loại đế TF', terms: ['TF'], scope: 'identity' }
      ]
    }
  }, message);
  const results = products.queryByPlan(route, message, 5);
  const answer = ai.fallbackFinal(message, route, results);

  assert.deepEqual(results, []);
  assert.deepEqual(answer.productIds, []);
  assert.doesNotMatch(answer.reply, /cầu lông|chạy bộ/i);
});

test('câu hỏi kiến thức được AI phân tích để tìm web và không hiện sản phẩm', () => {
  const { ai } = createServices();
  const message = 'FG và TF khác nhau thế nào?';
  const route = ai.fallbackRoute(message);
  const fallback = ai.fallbackFinal(message, route, []);

  assert.equal(route.intent, 'general_question');
  assert.equal(route.needDatabase, false);
  assert.equal(route.needWeb, true);
  assert.equal(route.showProducts, false);
  assert.equal(ai.shouldUseAiRouter(message, route), true);
  assert.deepEqual(fallback.productIds, []);
  assert.ok(fallback.suggestions.some((item) => /chi tiết/i.test(item.label)));
  assert.ok(fallback.suggestions.some((item) => /sản phẩm/i.test(item.label)));
});

test('câu sản phẩm rõ nhu cầu dùng code định tuyến và giới hạn payload balanced', () => {
  const { ai } = createServices();
  ai.config.costMode = 'balanced';
  ai.config.maxCandidates = 5;
  ai.config.maxVariants = 10;
  ai.config.descriptionChars = 650;
  ai.config.historyMessages = 4;
  ai.config.historyChars = 350;
  ai.config.finalMaxTokens = 520;

  const message = 'giày sân 7 chân bè dưới 2 triệu';
  const route = ai.fallbackRoute(message);
  const limits = ai.answerLimits(message, route);

  assert.equal(ai.shouldUseAiRouter(message, route), true);
  assert.equal(route.needFinalAi, false);
  assert.equal(limits.maxProducts, 3);
  assert.equal(limits.maxVariants, 4);
  assert.equal(limits.descriptionChars, 260);
  assert.equal(limits.historyMessages, 2);
  assert.equal(limits.historyChars, 220);
  assert.equal(limits.maxTokens, 320);
  assert.equal(limits.includeVariants, false);
});

test('nút hỏi tiếp về các mẫu vừa gợi ý giữ đúng productId trong lịch sử', () => {
  const { ai } = createServices();
  const route = ai.fallbackRoute('Kiểm tra màu và size còn hàng của các mẫu vừa gợi ý', [{
    role: 'assistant',
    text: 'Mình đã chọn được hai mẫu phù hợp.',
    contextProductIds: ['football-shoe', 'pickle-shoe']
  }]);

  assert.deepEqual(route.search.productIds, ['football-shoe', 'pickle-shoe']);
  assert.equal(route.needDatabase, true);
  assert.equal(ai.shouldUseAiRouter('Kiểm tra màu và size còn hàng của các mẫu vừa gợi ý', route), false);
});
