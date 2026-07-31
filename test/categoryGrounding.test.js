const test = require('node:test');
const assert = require('node:assert/strict');

const AiService = require('../src/aiService');
const { ProductService } = require('../src/productService');

function racket(id, sport) {
  return {
    id,
    name: `Vợt ${sport} ${id}`,
    type: `Vợt ${sport}`,
    brand: 'Promax',
    tags: sport,
    variants: [{
      id: `${id}-v1`,
      sku: `${id}-sku`,
      quantity: 3,
      inStock: true,
      price: 1200000
    }]
  };
}

function createServices(sports) {
  const products = new ProductService('', 'https://shop.example', { loadCsv: false });
  products.replaceProducts(sports.map((sport, index) => racket(`racket-${index + 1}`, sport)));
  const ai = new AiService({ maxCandidates: 5 }, products);
  return { ai, products };
}

function sportHistory(ai) {
  const firstRoute = ai.fallbackRoute('mua vợt');
  return {
    firstRoute,
    history: [{
      role: 'assistant',
      text: firstRoute.clarificationQuestion,
      route: firstRoute
    }]
  };
}

test('category không có trong catalog được từ chối trung thực và không bịa kiến thức', () => {
  const { ai } = createServices(['Cầu Lông', 'Tennis', 'Pickleball']);
  const { firstRoute, history } = sportHistory(ai);
  const route = ai.fallbackRoute('bóng bàn', history);
  const answer = ai.fallbackFinal('bóng bàn', route, []);

  assert.equal(route.showProducts, false);
  assert.equal(route.responseMode, 'clarify');
  assert.equal(route.consultation.pendingField, 'sport');
  assert.match(answer.reply, /shop hiện chưa có vợt bóng bàn/i);
  assert.doesNotMatch(answer.reply, /bóng bàn không dùng vợt/i);
  assert.notEqual(answer.reply, firstRoute.clarificationQuestion);
  assert.match(answer.reply, /vợt Cầu Lông.*vợt Pickleball.*vợt Tennis/i);
});

test('category có thật trong catalog được chấp nhận và hội thoại đi tiếp', () => {
  const { ai } = createServices(['Cầu Lông', 'Tennis', 'Pickleball', 'Bóng Bàn']);
  const { firstRoute, history } = sportHistory(ai);
  const route = ai.fallbackRoute('bóng bàn', history);

  assert.ok(route.search.categories.some((category) => /Vợt Bóng Bàn/i.test(category)));
  assert.notEqual(route.consultation.pendingField, 'sport');
  assert.notEqual(route.clarificationQuestion, firstRoute.clarificationQuestion);
  assert.doesNotMatch(route.clarificationQuestion, /chưa có/i);
});

test('router và final prompt chỉ nhận taxonomy được dựng từ catalog thật', () => {
  const { ai } = createServices(['Cầu Lông', 'Pickleball']);
  const routerPrompt = ai.buildRouterSystemPrompt();
  const finalPrompt = ai.buildFinalSystemPrompt();

  for (const prompt of [routerPrompt, finalPrompt]) {
    assert.match(prompt, /CATALOG_SUMMARY:/);
    assert.match(prompt, /Vợt Cầu Lông/);
    assert.match(prompt, /Vợt Pickleball/);
    assert.doesNotMatch(prompt, /Vợt Bóng Bàn/);
    assert.match(prompt, /không được bịa lý do chuyên môn/i);
  }
});
