const test = require('node:test');
const assert = require('node:assert/strict');

const AiService = require('../src/aiService');
const { ProductService } = require('../src/productService');

function makeProduct(id, { name, type, brand = 'Mizuno', color = '', size = '41', price = 1500000, tags = '' }) {
  return {
    id,
    name,
    type,
    brand,
    tags,
    images: [`https://cdn.example/${id}.jpg`],
    variants: [{
      id: `${id}-v1`,
      sku: `${id}-sku`,
      color,
      size,
      quantity: 3,
      inStock: true,
      price
    }]
  };
}

function setup() {
  const products = new ProductService('', 'https://shop.example');
  products.replaceProducts([
    makeProduct('pink-tf', {
      name: 'Giày Bóng Đá Mizuno Hồng TF Sân Cỏ Nhân Tạo',
      type: 'Giày Bóng Đá', color: 'Hồng', price: 1800000, tags: 'TF, sân 7, cỏ nhân tạo'
    }),
    makeProduct('blue-fg', {
      name: 'Giày Bóng Đá Mizuno Xanh FG Sân Cỏ Tự Nhiên',
      type: 'Giày Bóng Đá', color: 'Xanh', price: 1900000, tags: 'FG, sân 11, cỏ tự nhiên'
    }),
    makeProduct('run', {
      name: 'Giày Chạy Bộ Mizuno Wave Rider',
      type: 'Giày Chạy Bộ', color: 'Đen', price: 1400000, tags: 'đường nhựa, đệm êm'
    })
  ], 'haravan');
  return {
    products,
    ai: new AiService({ maxCandidates: 5, productFinalEnabled: false }, products)
  };
}

test('SQLite lọc đồng thời hard constraints và chỉ trả sản phẩm qua evidence gate', () => {
  const { products } = setup();
  const route = {
    action: 'SEARCH',
    search: {
      categories: ['Giày Bóng Đá'],
      colors: ['Hồng'],
      maxPrice: 1850000,
      requirements: [{
        label: 'Sân cỏ nhân tạo', terms: ['tf', 'cỏ nhân tạo'], scope: 'identity'
      }],
      excludeTerms: ['fg'],
      inStockOnly: true,
      limit: 5
    }
  };

  const results = products.queryByPlan(route, '', 5);

  assert.deepEqual(results.map((item) => item.id), ['pink-tf']);
  assert.equal(results[0].variants.find((variant) => variant.id === results[0].matchedVariantId).color, 'Hồng');
  assert.equal(products.status().database.engine, 'sqlite');
});

test('AI chọn ASK thì backend route không được tự đổi thành SEARCH', () => {
  const { ai } = setup();
  const route = ai.normalizeRoute({
    action: 'ASK',
    intent: 'search_product',
    needDatabase: true,
    showProducts: true,
    responseMode: 'brief',
    clarificationQuestion: 'Bạn sẽ dùng giày trên mặt sân nào?',
    consultation: { ready: false, pendingField: 'surface', missingFields: ['surface'] },
    search: { categories: ['Giày Bóng Đá'] }
  }, 'tư vấn giày bóng đá', { aiManaged: true });

  const finalized = ai.finalizeProductRoute(route, 'tư vấn giày bóng đá', []);

  assert.equal(finalized.action, 'ASK');
  assert.equal(finalized.needDatabase, false);
  assert.equal(finalized.showProducts, false);
  assert.equal(finalized.responseMode, 'clarify');
});

test('catalog profile lấy facet và mẫu đại diện từ dữ liệu Haravan thật', () => {
  const { products } = setup();
  const profile = products.getCatalogProfile({ search: { query: 'giày bóng đá' } });

  assert.ok(profile.types.some((item) => item.name === 'Giày Bóng Đá'));
  assert.ok(profile.colors.some((item) => item.name === 'Hồng'));
  assert.match(profile.text, /Mẫu đại diện từ dữ liệu thật/i);
  assert.doesNotMatch(profile.text, /Vợt Bóng Bàn/i);
});

test('chỉ nới màu sau khi SearchPlan ghi nhận khách đã đồng ý', () => {
  const { ai, products } = setup();
  const previous = ai.fallbackRoute('giày bóng đá màu tím dưới 2 triệu');
  const history = [{
    role: 'assistant',
    text: 'Shop chưa có đúng màu tím.',
    route: { ...previous, action: 'SEARCH', consultation: { ready: true, pendingField: '' } }
  }];
  const consent = ai.normalizeRoute({
    action: 'SEARCH',
    intent: 'search_product',
    showProducts: true,
    consultation: { ready: true },
    search: { query: 'bỏ màu', relaxConstraints: ['color'] }
  }, 'đồng ý bỏ màu', { aiManaged: true });
  const merged = ai.finalizeProductRoute(consent, 'đồng ý bỏ màu', history);
  const results = products.queryByPlan(merged, '', 5);

  assert.deepEqual(merged.search.colors, []);
  assert.ok(results.length > 0);
});
