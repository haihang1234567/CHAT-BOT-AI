const test = require('node:test');
const assert = require('node:assert/strict');

const AiService = require('../src/aiService');
const { ProductService } = require('../src/productService');

function product(id, name, price, description) {
  return {
    id,
    name,
    brand: 'Mizuno',
    type: 'Giày Chạy Bộ',
    description,
    tags: 'chạy bộ, đường nhựa',
    images: [],
    variants: [{
      id: `${id}-v1`,
      sku: `${id}-SKU`,
      size: '42',
      quantity: 5,
      inStock: true,
      price
    }]
  };
}

function createServices() {
  const products = new ProductService('', 'https://shop.example', { loadCsv: false });
  products.replaceProducts([
    product('wave-a', 'Mizuno Wave A', 1290000, 'Đệm EVA, thiết kế nhẹ cho chạy đường nhựa.'),
    product('wave-b', 'Mizuno Wave B', 1450000, 'Đế cao su bền, thân giày ổn định.'),
    product('wave-c', 'Mizuno Wave C', 1750000, 'Đệm foam dày, giá cao hơn ngân sách.')
  ]);
  const ai = new AiService({
    baseUrl: 'https://ai.example',
    token: 'test-token',
    routerModel: 'test-haiku',
    chatModel: 'test-haiku',
    messagesPath: '/v1/messages',
    authMode: 'bearer',
    style: 'anthropic',
    costMode: 'balanced',
    productFinalEnabled: false,
    maxCandidates: 3,
    maxVariants: 4,
    descriptionChars: 260,
    historyMessages: 2,
    historyChars: 220,
    finalMaxTokens: 320
  }, products);
  return { ai, products };
}

function finalInput(prompt) {
  const marker = 'INPUT_JSON:\n';
  const start = prompt.indexOf(marker);
  const end = prompt.lastIndexOf('\n\nOUTPUT_JSON_ONLY:');
  return JSON.parse(prompt.slice(start + marker.length, end));
}

test('câu xin tư vấn buộc final AI nêu lý do theo nhu cầu dù router trả brief', async () => {
  const { ai, products } = createServices();
  const message = 'Tư vấn giày chạy đường nhựa êm chân dưới 1,5 triệu';
  const route = ai.normalizeRoute({
    intent: 'product_recommendation',
    needDatabase: true,
    showProducts: true,
    responseMode: 'brief',
    search: {
      query: message,
      categories: ['giày chạy bộ'],
      customerNeeds: ['chạy đường nhựa', 'êm chân', 'dưới 1,5 triệu'],
      requirements: [{ label: 'Chạy đường nhựa', terms: ['đường nhựa'], scope: 'details' }],
      preferences: [{ label: 'Êm chân', terms: ['đệm', 'EVA'], scope: 'details' }],
      maxPrice: 1500000
    }
  }, message);
  const candidates = products.queryByPlan(route, message, 3);

  assert.equal(route.responseMode, 'recommend');
  assert.equal(route.needFinalAi, true);
  ai.call = async ({ messages }) => {
    const prompt = messages[0].content;
    const input = finalInput(prompt);
    assert.equal(input.asksAdvice, true);
    assert.equal(input.route.responseMode, 'recommend');
    assert.match(prompt, /chọn X vì Y/i);
    return JSON.stringify({
      reply: 'Mình chọn Mizuno Wave A vì đệm EVA hợp nhu cầu êm chân, chạy đường nhựa và giá 1.290.000đ vẫn dưới 1,5 triệu.',
      productIds: ['wave-a'],
      suggestions: [],
      needsAdmin: false
    });
  };

  const answer = await ai.answer(message, route, candidates);
  assert.match(answer.reply, /(đệm EVA|đường nhựa|1\.290\.000đ)/i);
  assert.deepEqual(answer.productIds, ['wave-a']);
});

test('mode compare yêu cầu và trả về tiêu chí khác biệt cụ thể', async () => {
  const { ai, products } = createServices();
  const message = 'So sánh Wave A và Wave B giúp mình';
  const route = ai.normalizeRoute({
    intent: 'compare_products',
    needDatabase: true,
    showProducts: true,
    responseMode: 'compare',
    search: { query: message, productIds: ['wave-a', 'wave-b'] }
  }, message);
  const candidates = products.queryByPlan(route, message, 3);

  ai.call = async ({ messages }) => {
    assert.match(messages[0].content, /2-3 khác biệt thực sự/i);
    return JSON.stringify({
      reply: 'Wave A rẻ hơn ở mức 1.290.000đ và dùng đệm EVA nhẹ; Wave B giá 1.450.000đ, dùng đế cao su và thiên về độ ổn định.',
      productIds: ['wave-a', 'wave-b'],
      suggestions: [],
      needsAdmin: false
    });
  };

  const answer = await ai.answer(message, route, candidates);
  assert.match(answer.reply, /(giá|đệm EVA|đế cao su|ổn định)/i);
  assert.deepEqual(answer.productIds, ['wave-a', 'wave-b']);
});
