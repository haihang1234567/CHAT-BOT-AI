const test = require('node:test');
const assert = require('node:assert/strict');

const AiService = require('../src/aiService');
const { ProductService } = require('../src/productService');

function product(id, name, type, brand, price = 1200000) {
  return {
    id,
    name,
    type,
    brand,
    tags: type,
    images: [`https://cdn.example/${id}.jpg`],
    variants: [{
      id: `${id}-v1`,
      sku: `${id}-sku`,
      size: '41',
      quantity: 5,
      inStock: true,
      price
    }]
  };
}

function createServices() {
  const products = new ProductService('', 'https://shop.example', { loadCsv: false });
  products.replaceProducts([
    ...Array.from({ length: 7 }, (_, index) => product(
      `run-${index + 1}`,
      `Giày Chạy Bộ Mizuno Mẫu ${index + 1}`,
      'Giày Chạy Bộ',
      'Mizuno',
      900000 + index * 50000
    )),
    product('pickle-1', 'Giày Pickleball Promax PI86', 'Giày Pickleball', 'Promax'),
    product('football-1', 'Giày Bóng Đá Mizuno TF', 'Giày Bóng Đá', 'Mizuno')
  ]);
  const ai = new AiService({
    maxCandidates: 5,
    productFinalEnabled: false,
    routerAlways: true,
    routerHistoryMessages: 4,
    routerHistoryChars: 350
  }, products);
  return { ai, products };
}

test('chuẩn hóa lỗi chính tả theo danh mục Haravan và hiểu giá 1500 là 1,5 triệu', () => {
  const { ai, products } = createServices();
  const message = 'giày chạy bộ mizno dưới 1500';
  const route = ai.fallbackRoute(message);
  const results = products.queryByPlan(route, message, 5);

  assert.ok(route.corrections.some((item) => item.input === 'mizno' && item.output === 'mizuno'));
  assert.equal(route.search.maxPrice, 1500000);
  assert.equal(route.showProducts, true);
  assert.equal(route.responseMode, 'brief');
  assert.equal(results.length, 5);
  assert.ok(results.every((item) => item.brand === 'Mizuno'));
});

test('giày pick được hiểu là pickleball nhưng hỏi nhu cầu trước khi gửi ảnh', () => {
  const { ai } = createServices();
  const route = ai.fallbackRoute('giày pick');

  assert.ok(route.search.categories.some((category) => /pickleball/i.test(category)));
  assert.equal(route.showProducts, false);
  assert.equal(route.responseMode, 'clarify');
  assert.equal(route.consultation.pendingField, 'usage');
  assert.match(route.clarificationQuestion, /trong nhà hay ngoài trời/i);
});

test('AI Router lỗi vẫn dùng bộ phân tích bằng code cho câu viết tắt', async () => {
  const { ai } = createServices();
  Object.assign(ai.config, {
    baseUrl: 'https://ai.example',
    token: 'test-token',
    routerModel: 'test-haiku',
    chatModel: 'test-haiku',
    routerMaxTokens: 220,
    cacheTtlMs: 60000
  });
  ai.call = async () => {
    throw new Error('API tạm thời không phản hồi');
  };

  const route = await ai.route('giày pick', [], { forceAi: true });
  assert.ok(route.search.categories.some((category) => /pickleball/i.test(category)));
  assert.equal(route.showProducts, false);
  assert.equal(route.consultation.pendingField, 'usage');
  assert.doesNotMatch(route.clarificationQuestion, /không thể phân tích/i);
});

test('giày chạy bộ dưới 1,5 triệu trả tối đa 5 sản phẩm ngay', () => {
  const { ai, products } = createServices();
  const message = 'giày chạy bộ dưới 1,5 triệu';
  const route = ai.fallbackRoute(message);
  const results = products.queryByPlan(route, message, route.search.limit);

  assert.equal(route.showProducts, true);
  assert.equal(route.consultation.ready, true);
  assert.equal(results.length, 5);
  assert.ok(results.every((item) => item.priceMin <= 1500000));
});

test('xem thêm giữ tiêu chí cũ và loại toàn bộ sản phẩm đã hiển thị', () => {
  const { ai, products } = createServices();
  const firstMessage = 'giày chạy bộ dưới 1,5 triệu';
  const firstRoute = ai.fallbackRoute(firstMessage);
  const firstProducts = products.queryByPlan(firstRoute, firstMessage, 5);
  const history = [
    { role: 'user', text: firstMessage },
    {
      role: 'assistant',
      text: 'Mình gửi 5 sản phẩm phù hợp.',
      productIds: firstProducts.map((item) => item.id),
      contextProductIds: firstProducts.map((item) => item.id),
      route: firstRoute
    }
  ];

  const nextRoute = ai.fallbackRoute('có còn đôi khác không', history);
  const nextProducts = products.queryByPlan(nextRoute, firstMessage, 5);
  const shown = new Set(firstProducts.map((item) => item.id));

  assert.equal(nextRoute.consultation.mode, 'more');
  assert.equal(nextRoute.showProducts, true);
  assert.deepEqual(new Set(nextRoute.search.excludeProductIds), shown);
  assert.ok(nextProducts.length > 0);
  assert.ok(nextProducts.every((item) => !shown.has(item.id)));
});

test('hội thoại hỏi lần lượt mục đích rồi ngân sách trước khi gửi sản phẩm', () => {
  const { ai } = createServices();
  const firstRoute = ai.fallbackRoute('giày chạy bộ');
  assert.equal(firstRoute.consultation.pendingField, 'usage');
  assert.match(firstRoute.clarificationQuestion, /đường nhựa/i);

  const historyAfterUsageQuestion = [{
    role: 'assistant',
    text: firstRoute.clarificationQuestion,
    route: firstRoute
  }];
  const secondRoute = ai.fallbackRoute('đường nhựa', historyAfterUsageQuestion);
  assert.equal(secondRoute.showProducts, false);
  assert.equal(secondRoute.consultation.pendingField, 'budget');
  assert.match(secondRoute.clarificationQuestion, /ngân sách/i);

  const historyAfterBudgetQuestion = [
    ...historyAfterUsageQuestion,
    { role: 'user', text: 'đường nhựa' },
    {
      role: 'assistant',
      text: secondRoute.clarificationQuestion,
      route: secondRoute
    }
  ];
  const finalRoute = ai.fallbackRoute('dưới 1500', historyAfterBudgetQuestion);
  assert.equal(finalRoute.showProducts, true);
  assert.equal(finalRoute.consultation.ready, true);
  assert.equal(finalRoute.search.maxPrice, 1500000);
});

test('câu trả lời ngân sách ngắn trong hội thoại bắt buộc được Haiku phân tích theo ngữ cảnh', async () => {
  const { ai } = createServices();
  Object.assign(ai.config, {
    baseUrl: 'https://ai.example',
    token: 'test-token',
    routerModel: 'test-haiku',
    chatModel: 'test-haiku',
    routerMaxTokens: 220,
    cacheTtlMs: 60000,
    routerAlways: false
  });

  const firstRoute = ai.fallbackRoute('giày pickleball');
  const historyAfterUsageQuestion = [{
    role: 'assistant',
    text: firstRoute.clarificationQuestion,
    route: firstRoute
  }];
  const secondRoute = ai.fallbackRoute('trong nhà', historyAfterUsageQuestion);
  const historyAfterBudgetQuestion = [
    { role: 'user', text: 'giày pickleball' },
    ...historyAfterUsageQuestion,
    { role: 'user', text: 'trong nhà' },
    {
      role: 'assistant',
      text: secondRoute.clarificationQuestion,
      route: secondRoute
    }
  ];

  let routerPrompt = '';
  let calls = 0;
  ai.call = async ({ messages }) => {
    calls += 1;
    routerPrompt = messages[0].content;
    return JSON.stringify({
      intent: 'search_product',
      needDatabase: true,
      needWeb: false,
      showProducts: true,
      responseMode: 'brief',
      clarificationQuestion: '',
      search: {
        query: 'giày pickleball trong nhà ngân sách 2 triệu',
        codes: [],
        productIds: [],
        names: [],
        brands: [],
        categories: ['pickleball'],
        colors: [],
        sizes: [],
        customerNeeds: ['Giày pickleball trong nhà', 'Ngân sách tối đa 2 triệu đồng'],
        requirements: [
          { label: 'Loại sản phẩm: Giày', terms: ['giày'], scope: 'identity' },
          { label: 'Môi trường chơi', terms: ['trong nhà'], scope: 'details' }
        ],
        preferences: [],
        excludeTerms: [],
        excludeProductIds: [],
        minPrice: null,
        maxPrice: 2000000,
        inStockOnly: false,
        limit: 5
      }
    });
  };

  const route = await ai.route('2tr', historyAfterBudgetQuestion);

  assert.equal(calls, 1);
  assert.match(routerPrompt, /"pendingField":"budget"/);
  assert.match(routerPrompt, /Khoảng ngân sách bạn muốn chọn là bao nhiêu/);
  assert.equal(route._source, 'ai-router');
  assert.equal(route.search.maxPrice, 2000000);
  assert.equal(route.showProducts, true);
  assert.equal(route.consultation.ready, true);
  assert.equal(route.clarificationQuestion, '');
});

test('giày bóng đá bắt buộc hỏi mặt sân trước khi hiện sản phẩm', () => {
  const { ai } = createServices();
  const route = ai.fallbackRoute('tư vấn giày bóng đá dưới 2 triệu');

  assert.equal(route.showProducts, false);
  assert.equal(route.consultation.pendingField, 'surface');
  assert.match(route.clarificationQuestion, /cỏ nhân tạo|cỏ tự nhiên|trong nhà/i);
});
