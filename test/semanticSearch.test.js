const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  EmbeddingService,
  buildProductEmbeddingText,
  cosineSimilarity
} = require('../src/embeddingService');
const { ProductService } = require('../src/productService');

function product(id, name, price = 1000000) {
  return {
    id,
    name,
    type: 'Giày Chạy Bộ',
    brand: 'Mizuno',
    tags: 'giày thể thao',
    excerpt: 'Đệm đàn hồi và đế bám đường.',
    description: 'NOISE_FROM_LONG_HTML_DESCRIPTION',
    collections: ['Giày chạy'],
    variants: [{
      id: `${id}-v1`,
      sku: `${id}-sku`,
      color: 'Xanh',
      size: '41',
      quantity: 3,
      inStock: true,
      price
    }]
  };
}

test('text embedding sản phẩm dùng dữ liệu ngắn, thuộc tính quan trọng và bỏ description dài', () => {
  const text = buildProductEmbeddingText(product('run-1', 'Giày Mizuno Êm Chân'));

  assert.match(text, /Giày Mizuno Êm Chân/);
  assert.match(text, /Giày Chạy Bộ/);
  assert.match(text, /Mizuno/);
  assert.match(text, /Đệm đàn hồi/);
  assert.match(text, /Màu: Xanh/);
  assert.match(text, /Size: 41/);
  assert.doesNotMatch(text, /NOISE_FROM_LONG_HTML_DESCRIPTION/);
});

test('cosine similarity tính đúng và từ chối vector sai chiều', () => {
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  assert.equal(cosineSimilarity([1], [1, 0]), -1);
});

test('Voyage API nhận đúng model và input_type cho document/query', async () => {
  const requests = [];
  const service = new EmbeddingService({
    enabled: true,
    apiKey: 'voyage-test-key',
    endpoint: 'https://api.voyageai.com/v1/embeddings',
    model: 'voyage-4-lite',
    outputDimension: 512,
    timeoutMs: 3000,
    queryCacheTtlMs: 60000
  }, async (_url, options) => {
    requests.push({
      headers: options.headers,
      body: JSON.parse(options.body)
    });
    const input = JSON.parse(options.body).input;
    return {
      ok: true,
      text: async () => JSON.stringify({
        data: input.map((_, index) => ({ index, embedding: [1, index] }))
      })
    };
  });

  await service.embedTexts(['sản phẩm A', 'sản phẩm B'], 'document');
  await service.embedText('khách cần giày êm chân', 'query');
  await service.embedText('khách cần giày êm chân', 'query');

  assert.equal(requests.length, 2);
  assert.equal(requests[0].headers.Authorization, 'Bearer voyage-test-key');
  assert.equal(requests[0].body.model, 'voyage-4-lite');
  assert.equal(requests[0].body.input_type, 'document');
  assert.equal(requests[0].body.output_dimension, 512);
  assert.equal(requests[1].body.input_type, 'query');
});

test('build embeddings chỉ gọi Voyage cho sản phẩm mới hoặc thay đổi', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghs-embeddings-'));
  const indexPath = path.join(tempDir, 'embeddings.json');
  let requests = 0;
  const config = {
    enabled: true,
    apiKey: 'voyage-test-key',
    endpoint: 'https://api.voyageai.com/v1/embeddings',
    model: 'voyage-4-lite',
    outputDimension: 2,
    timeoutMs: 3000,
    batchSize: 10,
    queryCacheTtlMs: 60000,
    indexPath
  };
  const fetchMock = async (_url, options) => {
    requests += 1;
    const input = JSON.parse(options.body).input;
    return {
      ok: true,
      text: async () => JSON.stringify({
        data: input.map((_, index) => ({ index, embedding: [1, index + 1] }))
      })
    };
  };

  try {
    const service = new EmbeddingService(config, fetchMock);
    const catalog = [
      product('run-1', 'Giày Chạy Một'),
      product('run-2', 'Giày Chạy Hai')
    ];
    const first = await service.syncProducts(catalog);
    const second = await service.syncProducts(catalog);
    catalog[1].excerpt = 'Nội dung mới cho sản phẩm thứ hai.';
    const third = await service.syncProducts(catalog);
    const reloaded = new EmbeddingService(config, fetchMock);

    assert.deepEqual(
      [first.built, second.built, third.built],
      [2, 0, 1]
    );
    assert.equal(requests, 2);
    assert.equal(reloaded.entries.size, 2);
    assert.ok(fs.existsSync(indexPath));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('semanticSearch xếp hạng theo vector cố định và hybrid vẫn áp dụng bộ lọc code', async () => {
  const vectors = new Map([
    ['cheap', [0.2, 0.8]],
    ['best', [1, 0]],
    ['wrong-price', [0.99, 0.01]]
  ]);
  let embedCalls = 0;
  const embeddingService = {
    config: { minScore: -1 },
    isConfigured: () => true,
    status: () => ({ enabled: true, configured: true, vectorCount: vectors.size }),
    getVector: (id) => vectors.get(String(id)),
    embedText: async () => {
      embedCalls += 1;
      return [1, 0];
    }
  };
  const products = new ProductService('', 'https://shop.example', {
    loadCsv: false,
    embeddingService
  });
  products.replaceProducts([
    product('cheap', 'Giày Chạy Giá Thấp', 900000),
    product('best', 'Giày Chạy Đường Dài', 1400000),
    product('wrong-price', 'Giày Chạy Cao Cấp', 3200000)
  ]);

  const semantic = await products.semanticSearch('êm chân khi đi nhiều giờ', 3);
  assert.deepEqual(semantic.map((item) => item.id), ['best', 'wrong-price', 'cheap']);

  const hybrid = await products.hybridQueryByPlan({
    responseMode: 'recommend',
    search: {
      query: 'êm chân khi đi nhiều giờ',
      maxPrice: 1500000,
      limit: 3
    }
  }, 'êm chân khi đi nhiều giờ', 3);

  assert.equal(hybrid[0].id, 'best');
  assert.ok(hybrid.every((item) => item.priceMin <= 1500000));
  assert.ok(embedCalls >= 2);
});

test('tra SKU chính xác không gọi semantic search và không thêm sản phẩm gần giống', async () => {
  let embedCalls = 0;
  const embeddingService = {
    config: { minScore: -1 },
    isConfigured: () => true,
    status: () => ({ enabled: true, configured: true, vectorCount: 2 }),
    getVector: () => [1, 0],
    embedText: async () => {
      embedCalls += 1;
      return [1, 0];
    }
  };
  const products = new ProductService('', 'https://shop.example', {
    loadCsv: false,
    embeddingService
  });
  products.replaceProducts([
    product('exact', 'Giày Chính Xác'),
    product('other', 'Giày Khác')
  ]);

  const results = await products.hybridQueryByPlan({
    responseMode: 'recommend',
    search: { query: 'exact-sku', codes: ['exact-sku'], limit: 5 }
  }, 'exact-sku', 5);

  assert.deepEqual(results.map((item) => item.id), ['exact']);
  assert.equal(embedCalls, 0);
});

test('chưa có vector sản phẩm thì không tốn call Voyage cho câu hỏi khách', async () => {
  let embedCalls = 0;
  const embeddingService = {
    config: { minScore: -1 },
    isConfigured: () => true,
    status: () => ({ enabled: true, configured: true, vectorCount: 0 }),
    getVector: () => null,
    embedText: async () => {
      embedCalls += 1;
      return [1, 0];
    }
  };
  const products = new ProductService('', 'https://shop.example', {
    loadCsv: false,
    embeddingService
  });
  products.replaceProducts([product('run-1', 'Giày Chạy Bộ')]);

  const results = await products.semanticSearch('giày êm chân', 3);

  assert.deepEqual(results, []);
  assert.equal(embedCalls, 0);
});
