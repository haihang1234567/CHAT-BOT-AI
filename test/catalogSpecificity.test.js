const test = require('node:test');
const assert = require('node:assert/strict');

const AiService = require('../src/aiService');
const { ProductService } = require('../src/productService');

function product(id, name, type) {
  return {
    id, name, type, brand: 'GHS', tags: type, images: [],
    variants: [{ id: `${id}-v`, sku: `${id}-sku`, price: 500000, quantity: 2, inStock: true }]
  };
}

function setup() {
  const products = new ProductService('', 'https://shop.example', { loadCsv: false });
  products.replaceProducts([
    product('badminton-racket', 'Vợt Cầu Lông', 'Vợt Cầu Lông'),
    product('pickle-racket', 'Vợt Pickleball', 'Vợt Pickleball'),
    product('football-ball', 'Quả Bóng Đá', 'Bóng Đá'),
    product('volleyball-ball', 'Quả Bóng Chuyền', 'Bóng Chuyền'),
    product('badminton-shirt', 'Áo Cầu Lông', 'Áo Cầu Lông'),
    product('running-pants', 'Quần Chạy Bộ', 'Quần Chạy Bộ'),
    product('racket-bag', 'Túi Đựng Vợt', 'Túi Đựng Vợt'),
    product('sports-accessory', 'Phụ Kiện Thể Thao', 'Phụ Kiện Thể Thao'),
    product('shin-guard', 'Ống Đồng Bảo Hộ Bóng Đá', 'Bảo Hộ Bóng Đá'),
    product('training-tool', 'Dụng Cụ Tập Cầu Lông', 'Dụng Cụ Cầu Lông')
  ], 'haravan');
  return { products, ai: new AiService({ maxCandidates: 5, productFinalEnabled: false }, products) };
}

test('nhóm hàng tổng quát đều phải ASK theo taxonomy Haravan, không riêng vợt', () => {
  const { ai } = setup();
  const cases = [
    ['có vợt không', /Cầu Lông.*Pickleball/i],
    ['có quả bóng không', /(?:Đá.*Chuyền|Chuyền.*Đá)/i],
    ['cho xem quần áo', /Áo Cầu Lông.*Quần Chạy Bộ/i],
    ['có túi không', /Đựng Vợt/i],
    ['có phụ kiện không', /Thể Thao/i],
    ['mua đồ bảo hộ', /Bóng Đá/i],
    ['tìm dụng cụ', /Cầu Lông/i]
  ];

  for (const [message, choices] of cases) {
    const route = ai.fallbackRoute(message);
    assert.equal(route.action, 'ASK', message);
    assert.equal(route.showProducts, false, message);
    assert.deepEqual(route.search.categories, [], message);
    assert.match(route.clarificationQuestion, choices, message);
  }
});

test('AI tự thêm cầu lông khi khách chỉ hỏi vợt bị evidence gate loại bỏ', () => {
  const { ai } = setup();
  const hallucinated = ai.normalizeRoute({
    action: 'SEARCH', intent: 'search_product', showProducts: true,
    consultation: { ready: true },
    search: {
      query: 'vợt cầu lông',
      categories: ['Vợt Cầu Lông'],
      brands: ['GHS']
    }
  }, 'có vợt không', { aiManaged: true });
  const route = ai.finalizeProductRoute(hallucinated, 'có vợt không', []);

  assert.equal(route.action, 'ASK');
  assert.equal(route.showProducts, false);
  assert.deepEqual(route.search.categories, []);
  assert.deepEqual(route.search.brands, []);
  assert.match(route.clarificationQuestion, /Cầu Lông.*Pickleball/i);
});

test('câu đúng “hãy hỏi thương hiệu” không bị biến thành ambiguity catalog', () => {
  const { products } = setup();
  const resolution = products.normalizeCatalogQuery('Hãy hỏi thương hiệu tôi ưu tiên rồi lọc lại sản phẩm');
  assert.deepEqual(resolution.ambiguous, []);
  assert.ok(!resolution.corrections.some((item) => item.input === 'hay'));
});
