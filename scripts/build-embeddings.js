const fs = require('fs');

const loadEnv = require('../src/env');
loadEnv();

const config = require('../src/config');
const { EmbeddingService } = require('../src/embeddingService');
const { ProductService } = require('../src/productService');
const HaravanService = require('../src/haravanService');

async function main() {
  const embedding = new EmbeddingService(config.embedding);
  if (!embedding.isConfigured()) {
    throw new Error('Thiếu VOYAGE_API_KEY hoặc VOYAGE_EMBEDDING_ENABLED=false.');
  }

  const loadCsv = config.productSource === 'csv'
    || (config.haravan.fallbackToCsv && fs.existsSync(config.productCsvPath));
  const products = new ProductService(config.productCsvPath, config.shopDomain, {
    loadCsv,
    embeddingService: embedding
  });

  if (config.productSource === 'haravan') {
    const haravan = new HaravanService(config.haravan, products);
    if (!haravan.isConfigured()) {
      if (!products.products.length) {
        throw new Error('PRODUCT_SOURCE=haravan nhưng chưa có HARAVAN_ACCESS_TOKEN và không có CSV dự phòng.');
      }
      console.warn('[EMBEDDINGS] Chưa có HARAVAN_ACCESS_TOKEN; đang dùng CSV dự phòng.');
    } else {
      await haravan.sync();
    }
  }

  if (!products.products.length) throw new Error('Catalog không có sản phẩm để tạo embedding.');
  const force = process.argv.includes('--force');
  const stats = await embedding.syncProducts(products.products, {
    force,
    onProgress: ({ built, pending, total }) => {
      console.log(`[EMBEDDINGS] ${built}/${pending} vector cần tạo; catalog ${total} sản phẩm.`);
    }
  });
  console.log(JSON.stringify({
    ok: true,
    provider: 'voyage',
    model: config.embedding.model,
    outputDimension: config.embedding.outputDimension,
    indexPath: config.embedding.indexPath,
    ...stats
  }, null, 2));
}

main().catch((error) => {
  console.error(`[EMBEDDINGS] ${error.message}`);
  process.exitCode = 1;
});
