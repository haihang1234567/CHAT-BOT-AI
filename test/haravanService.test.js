const test = require('node:test');
const assert = require('node:assert/strict');

const { ProductService } = require('../src/productService');
const HaravanService = require('../src/haravanService');

function jsonResponse(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => value,
    text: async () => JSON.stringify(value)
  };
}

test('đồng bộ sản phẩm, thuộc tính, nhóm và tồn kho Haravan', async () => {
  const calls = [];
  const fetchMock = async (rawUrl, options) => {
    const url = new URL(rawUrl);
    calls.push({ url, options });
    assert.equal(options.headers.Authorization, 'Bearer token-test');

    if (url.pathname.endsWith('/products.json')) {
      return jsonResponse({
        products: [
          {
            id: 101,
            title: 'Giày đá bóng thử nghiệm',
            handle: 'giay-da-bong-thu-nghiem',
            vendor: 'Mizuno',
            product_type: 'Giày bóng đá',
            tags: 'TF, sân 7',
            body_html: '<p>Đế TF dành cho sân cỏ nhân tạo.</p>',
            published_at: '2026-01-01T00:00:00Z',
            only_hide_from_list: false,
            options: [
              { name: 'Màu sắc', position: 1 },
              { name: 'Size', position: 2 }
            ],
            images: [
              { id: 9001, position: 1, src: 'https://cdn.example/black.jpg', variant_ids: [201] }
            ],
            variants: [
              {
                id: 201,
                sku: 'SKU-BLACK-40',
                barcode: '89300001',
                option1: 'Đen',
                option2: '40',
                price: 1499000,
                compare_at_price: 1700000,
                inventory_quantity: 99,
                image_id: 9001
              }
            ]
          },
          {
            id: 102,
            title: 'Áo thể thao một thuộc tính',
            handle: 'ao-the-thao',
            vendor: 'Mizuno',
            product_type: 'Áo',
            published_at: '2026-01-01T00:00:00Z',
            only_hide_from_list: false,
            options: [{ name: 'Kích thước', position: 1 }],
            images: [],
            variants: [
              { id: 202, sku: 'AO-S', option1: 'S', price: 500000, inventory_quantity: 2 }
            ]
          }
        ]
      });
    }
    if (url.pathname.endsWith('/custom_collections.json')) {
      return jsonResponse({
        custom_collections: [{ id: 301, title: 'Giày sân cỏ nhân tạo', handle: 'giay-san-co-nhan-tao' }]
      });
    }
    if (url.pathname.endsWith('/smart_collections.json')) {
      return jsonResponse({ smart_collections: [] });
    }
    if (url.pathname.endsWith('/collects.json')) {
      return jsonResponse({ collects: [{ id: 401, product_id: 101, collection_id: 301 }] });
    }
    if (url.pathname.endsWith('/locations.json')) {
      return jsonResponse({ locations: [{ id: 501, name: 'Kho chính', is_unavailable_quantity: false }] });
    }
    if (url.pathname.endsWith('/inventory_locations.json')) {
      return jsonResponse({
        inventory_locations: [
          { id: 601, loc_id: 501, product_id: 101, variant_id: 201, qty_available: 3 },
          { id: 602, loc_id: 501, product_id: 102, variant_id: 202, qty_available: 0 }
        ]
      });
    }
    return jsonResponse({ error: 'not found' }, 404);
  };

  const productService = new ProductService('', 'https://shop.example', { loadCsv: false });
  const haravan = new HaravanService({
    baseUrl: 'https://apis.haravan.com/com',
    token: 'token-test',
    timeoutMs: 5000,
    pageSize: 50,
    syncIntervalMs: 600000,
    includeUnpublished: false,
    useLocationInventory: true,
    locationIds: []
  }, productService, fetchMock);

  const stats = await haravan.sync();

  assert.deepEqual(stats, {
    products: 2,
    variants: 2,
    collections: 1,
    locationInventory: true
  });
  assert.equal(productService.source, 'haravan');
  assert.equal(productService.products.length, 2);

  const shoe = productService.getProduct('101');
  assert.deepEqual(shoe.colors, ['Đen']);
  assert.deepEqual(shoe.sizes, ['40']);
  assert.deepEqual(shoe.collections, ['Giày sân cỏ nhân tạo']);
  assert.equal(shoe.variants[0].quantity, 3);
  assert.equal(shoe.variants[0].inStock, true);
  assert.equal(shoe.variants[0].image, 'https://cdn.example/black.jpg');

  const shirt = productService.getProduct('102');
  assert.deepEqual(shirt.colors, []);
  assert.deepEqual(shirt.sizes, ['S']);
  assert.equal(shirt.variants[0].inStock, false);

  const byCollection = productService.search('giày sân cỏ nhân tạo', 5);
  assert.equal(byCollection[0].id, '101');
  assert.ok(calls.some((call) => call.url.pathname.endsWith('/inventory_locations.json')));
});

test('không thay dữ liệu đang chạy khi Haravan trả lỗi', async () => {
  const productService = new ProductService('', 'https://shop.example', { loadCsv: false });
  productService.replaceProducts([{
    id: 'old',
    name: 'Sản phẩm đang chạy',
    images: [],
    variants: []
  }], 'memory');

  const haravan = new HaravanService({
    baseUrl: 'https://apis.haravan.com/com',
    token: 'token-test',
    timeoutMs: 5000,
    pageSize: 50,
    syncIntervalMs: 600000,
    includeUnpublished: false,
    useLocationInventory: false,
    locationIds: []
  }, productService, async () => jsonResponse({ error: 'unauthorized' }, 401));

  await assert.rejects(() => haravan.sync(), /Haravan 401/);
  assert.equal(productService.getProduct('old').name, 'Sản phẩm đang chạy');
  assert.equal(haravan.status().lastError.includes('Haravan 401'), true);
});
