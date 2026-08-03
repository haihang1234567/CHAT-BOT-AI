const test = require('node:test');
const assert = require('node:assert/strict');

const AiService = require('../src/aiService');
const { ProductService } = require('../src/productService');

function product(id, { name, type, brand, variants, tags = '' }) {
  return { id, name, type, brand, tags, images: [], variants };
}

function variant(id, color, size, price = 900000) {
  return { id, sku: `${id}-sku`, color, size, price, quantity: 3, inStock: true };
}

function setup() {
  const products = new ProductService('', 'https://shop.example', { loadCsv: false });
  products.replaceProducts([
    product('mixed-shirt', {
      name: 'Áo Cầu Lông Yonex Nhiều Màu', type: 'Áo Cầu Lông', brand: 'Yonex',
      variants: [variant('mixed-black-40', 'Đen', '40'), variant('mixed-white-41', 'Trắng', '41')]
    }),
    product('blue-shirt', {
      name: 'Áo Cầu Lông Yonex Xanh', type: 'Áo Cầu Lông', brand: 'Yonex',
      variants: [variant('blue-42', 'Xanh', '42')]
    }),
    product('mizuno-run', {
      name: 'Giày Chạy Bộ Mizuno', type: 'Giày Chạy Bộ', brand: 'Mizuno',
      variants: [variant('mizuno-run-41', 'Trắng', '41', 1400000)]
    }),
    product('asics-run', {
      name: 'Giày Chạy Bộ Asics', type: 'Giày Chạy Bộ', brand: 'Asics',
      variants: [variant('asics-run-41', 'Đen', '41', 1500000)]
    }),
    product('badminton-racket', {
      name: 'Vợt Cầu Lông Yonex', type: 'Vợt Cầu Lông', brand: 'Yonex',
      variants: [variant('badminton-racket-v', '', '')]
    }),
    product('pickleball-racket', {
      name: 'Vợt Pickleball Promax', type: 'Vợt Pickleball', brand: 'Promax',
      variants: [variant('pickleball-racket-v', '', '')]
    })
  ], 'haravan');
  return { products, ai: new AiService({ maxCandidates: 5, productFinalEnabled: false }, products) };
}

test('phủ định màu loại đúng biến thể nhưng vẫn giữ sản phẩm có màu phù hợp khác', () => {
  const { ai, products } = setup();
  const rules = ai.codeSearchRules('áo cầu lông không phải màu đen');
  const results = products.queryByPlan({ search: { ...rules, limit: 10 } }, '', 10);

  assert.deepEqual(rules.colors, []);
  assert.deepEqual(rules.excludeColors, ['den']);
  assert.deepEqual(results.map((item) => item.id).sort(), ['blue-shirt', 'mixed-shirt']);
  const mixed = results.find((item) => item.id === 'mixed-shirt');
  assert.deepEqual(mixed.variants.map((item) => item.color), ['Trắng']);
});

test('phủ định size chỉ ẩn biến thể bị loại', () => {
  const { ai, products } = setup();
  const rules = ai.codeSearchRules('áo cầu lông size nào cũng được nhưng không lấy size 40');
  const results = products.queryByPlan({ search: { ...rules, limit: 10 } }, '', 10);

  assert.deepEqual(rules.excludeSizes, ['40']);
  assert.ok(results.every((item) => item.variants.every((item) => item.size !== '40')));
  assert.ok(results.some((item) => item.id === 'mixed-shirt'));
});

test('phủ định hãng và category không bị đưa ngược vào bộ lọc dương', () => {
  const { ai, products } = setup();
  const brandRules = ai.codeSearchRules('giày chạy bộ hãng nào cũng được trừ Mizuno');
  const brandResults = products.queryByPlan({ search: { ...brandRules, limit: 10 } }, '', 10);
  assert.deepEqual(brandRules.brands, []);
  assert.deepEqual(brandRules.excludeBrands, ['mizuno']);
  assert.deepEqual(brandResults.map((item) => item.id), ['asics-run']);

  const categoryRules = ai.codeSearchRules('không muốn vợt cầu lông, tôi cần vợt pickleball');
  assert.deepEqual(categoryRules.excludeCategories, ['Vợt Cầu Lông']);
  assert.deepEqual(categoryRules.categories, ['Vợt Pickleball']);
});

test('router prompt dạy rõ phủ định có cấu trúc', () => {
  const { ai } = setup();
  const prompt = ai.buildRouterSystemPrompt();
  assert.match(prompt, /excludeBrands.*excludeCategories.*excludeColors.*excludeSizes/i);
  assert.match(prompt, /không phải.*không muốn.*ngoại trừ/i);
});
