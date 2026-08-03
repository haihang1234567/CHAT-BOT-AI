const test = require('node:test');
const assert = require('node:assert/strict');

const AiService = require('../src/aiService');
const { ProductService } = require('../src/productService');

function product(id, price, size) {
  return {
    id,
    name: `Giày Chạy Bộ ${id}`,
    type: 'Giày Chạy Bộ',
    brand: 'Mizuno',
    tags: 'chạy đường nhựa',
    images: [],
    variants: [{
      id: `${id}-v`, sku: `${id}-sku`, color: 'Xanh', size,
      price, quantity: 3, inStock: true
    }]
  };
}

function setup() {
  const products = new ProductService('', 'https://shop.example', { loadCsv: false });
  products.replaceProducts([
    product('reference', 2000000, '40'),
    product('cheaper', 1500000, '41'),
    product('expensive', 2500000, '39')
  ], 'haravan');
  const ai = new AiService({ maxCandidates: 5, productFinalEnabled: false }, products);
  const baseRoute = ai.fallbackRoute('giày chạy bộ dưới 3 triệu');
  const history = [{
    role: 'assistant',
    text: 'Mình gửi sản phẩm tham chiếu.',
    productIds: ['reference'],
    contextProductIds: ['reference'],
    contextVariants: [{ productId: 'reference', variantId: 'reference-v' }],
    route: { ...baseRoute, action: 'SEARCH', consultation: { ready: true, pendingField: '' } }
  }];
  return { ai, products, history };
}

test('“rẻ hơn cái vừa xem” dùng giá biến thể thật làm maxPrice', () => {
  const { ai, products, history } = setup();
  const route = ai.fallbackRoute('rẻ hơn cái vừa xem', history);
  const results = products.queryByPlan(route, '', 10);

  assert.equal(route.action, 'SEARCH');
  assert.ok(route.search.maxPrice < 2000000);
  assert.ok(route.search.excludeProductIds.includes('reference'));
  assert.deepEqual(results.map((item) => item.id), ['cheaper']);
});

test('so sánh size dùng đúng biến thể tham chiếu đã hiển thị', () => {
  const { ai, products, history } = setup();
  const route = ai.fallbackRoute('cho size lớn hơn cái đó', history);
  const results = products.queryByPlan(route, '', 10);

  assert.ok(route.search.sizes.includes('41'));
  assert.deepEqual(results.map((item) => item.id), ['cheaper']);
});

test('nhiều sản phẩm tham chiếu thì hỏi khách chọn, không tự đoán', () => {
  const { ai, history } = setup();
  history[0].productIds = ['reference', 'cheaper'];
  history[0].contextProductIds = ['reference', 'cheaper'];
  const route = ai.fallbackRoute('rẻ hơn cái vừa xem', history);

  assert.equal(route.action, 'ASK');
  assert.equal(route.showProducts, false);
  assert.match(route.clarificationQuestion, /so với sản phẩm nào/i);
});

test('router nhận dữ liệu giá và biến thể thật trước khi quyết định', async () => {
  const { ai, history } = setup();
  Object.assign(ai.config, {
    baseUrl: 'https://ai.example', token: 'token', routerModel: 'haiku-test',
    chatModel: 'haiku-test', messagesPath: '/v1/messages', authMode: 'bearer',
    style: 'anthropic', routerMaxTokens: 500, routerAlways: true, cacheTtlMs: 0
  });
  let prompt = '';
  ai.call = async ({ messages }) => {
    prompt = messages[0].content;
    return JSON.stringify({
      action: 'SEARCH', intent: 'search_product', showProducts: true,
      consultation: { ready: true },
      search: { query: 'giày chạy bộ rẻ hơn', categories: ['Giày Chạy Bộ'] }
    });
  };

  const route = await ai.route('rẻ hơn cái vừa xem', history);
  assert.match(prompt, /"referencePrice":2000000/);
  assert.match(prompt, /"referenceVariantId":"reference-v"/);
  assert.ok(route.search.maxPrice < 2000000);
});
