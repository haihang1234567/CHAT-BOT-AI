const test = require('node:test');
const assert = require('node:assert/strict');

const { ProductService } = require('../src/productService');

function product(id, type, brand, variants) {
  return {
    id,
    name: `${type} ${id}`,
    type,
    brand,
    variants
  };
}

function variant(id, price, inStock = true) {
  return {
    id,
    sku: `${id}-sku`,
    price,
    quantity: inStock ? 2 : 0,
    inStock
  };
}

test('catalog summary chỉ đếm sản phẩm còn hàng và gộp type không phân biệt hoa thường', () => {
  const products = new ProductService('', 'https://shop.example', { loadCsv: false });
  products.replaceProducts([
    product('shoe-1', 'Giày Cầu Lông', 'Mizuno', [variant('shoe-1-v1', 900000)]),
    product('shoe-2', 'giày cầu lông', 'Mizuno', [variant('shoe-2-v1', 1400000)]),
    product('racket-1', 'Vợt Pickleball', 'Promax', [variant('racket-1-v1', 2100000)]),
    product('table-1', 'Vợt Bóng Bàn', 'Promax', [variant('table-1-v1', 700000, false)])
  ]);

  const summary = products.getCatalogSummary();
  const badminton = summary.typeStats.find((type) => type.normalized === 'giay cau long');

  assert.equal(summary.totalProducts, 3);
  assert.deepEqual(summary.types, ['Giày Cầu Lông', 'Vợt Pickleball']);
  assert.equal(badminton.count, 2);
  assert.equal(badminton.min, 900000);
  assert.equal(badminton.max, 1400000);
  assert.deepEqual(
    summary.brands.map(({ name, count }) => [name, count]),
    [['Mizuno', 2], ['Promax', 1]]
  );
  assert.equal(summary.priceMin, 900000);
  assert.equal(summary.priceMax, 2100000);
  assert.match(summary.text, /tổng 3 sản phẩm còn hàng/i);
  assert.doesNotMatch(summary.text, /bóng bàn/i);
});

test('replaceProducts dựng lại cache catalog summary đúng một nguồn dữ liệu mới', () => {
  const products = new ProductService('', 'https://shop.example', { loadCsv: false });
  products.replaceProducts([
    product('old', 'Giày Chạy Bộ', 'Mizuno', [variant('old-v1', 1200000)])
  ]);
  const firstSummary = products.getCatalogSummary();

  products.replaceProducts([
    product('new', 'Vợt Tennis', 'Promax', [variant('new-v1', 1800000)])
  ], 'haravan');
  const nextSummary = products.getCatalogSummary();

  assert.notEqual(firstSummary, nextSummary);
  assert.deepEqual(nextSummary.types, ['Vợt Tennis']);
  assert.doesNotMatch(nextSummary.text, /Giày Chạy Bộ/);
});
