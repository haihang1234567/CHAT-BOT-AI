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

  const products = new ProductService('', config.shopDomain, {
    loadCsv: false,
    embeddingService: embedding
  });

  const haravan = new HaravanService(config.haravan, products);
  if (!haravan.isConfigured()) throw new Error('Thiếu HARAVAN_ACCESS_TOKEN.');
  await haravan.sync();

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
