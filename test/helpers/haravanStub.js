const http = require('node:http');

function json(res, payload, status = 200) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function createHaravanProduct({
  id,
  name,
  handle,
  brand = 'Mizuno',
  type = 'Giày thể thao',
  tags = '',
  description = '',
  color = 'Trắng',
  size = '42',
  sku,
  quantity = 5,
  price = 1_000_000,
  compareAtPrice = 0,
  image
}) {
  const productId = String(id);
  const variantId = `${productId}-variant`;
  const imageUrl = image || `https://cdn.example.com/${productId}.jpg`;
  return {
    id: productId,
    title: name,
    handle: handle || productId,
    vendor: brand,
    product_type: type,
    tags,
    body_plain: description,
    published_at: '2026-01-01T00:00:00Z',
    only_hide_from_list: false,
    options: [
      { name: 'Màu', position: 1 },
      { name: 'Size', position: 2 }
    ],
    images: [{ id: `${productId}-image`, position: 1, src: imageUrl, variant_ids: [variantId] }],
    variants: [{
      id: variantId,
      sku: sku || `${productId}-42`,
      barcode: '',
      option1: color,
      option2: size,
      price,
      compare_at_price: compareAtPrice,
      inventory_quantity: quantity,
      image_id: `${productId}-image`
    }]
  };
}

async function startHaravanStub(products) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname.endsWith('/products.json')) return json(res, { products });
    if (url.pathname.endsWith('/custom_collections.json')) return json(res, { custom_collections: [] });
    if (url.pathname.endsWith('/smart_collections.json')) return json(res, { smart_collections: [] });
    if (url.pathname.endsWith('/collects.json')) return json(res, { collects: [] });
    return json(res, { error: 'not found' }, 404);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}/com`,
    env: {
      HARAVAN_API_BASE_URL: `http://127.0.0.1:${port}/com`,
      HARAVAN_ACCESS_TOKEN: 'test-haravan-token',
      HARAVAN_USE_LOCATION_INVENTORY: 'false',
      VOYAGE_EMBEDDING_ENABLED: 'false',
      VOYAGE_API_KEY: ''
    },
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

module.exports = { createHaravanProduct, startHaravanStub };
