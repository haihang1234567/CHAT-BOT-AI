const test = require('node:test');
const assert = require('node:assert/strict');

const AiService = require('../src/aiService');
const { ProductService, canonicalSearchText } = require('../src/productService');

function variant(id) {
  return {
    id,
    sku: `${id}-SKU`,
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
      variants: [variant('football-shoe-v1')]
    }
  ]);

  const ai = new AiService({
    alwaysFinal: true,
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
