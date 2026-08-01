const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('cấu hình sản phẩm luôn dùng Haravan và bỏ các biến fallback CSV cũ', () => {
  const projectRoot = path.resolve(__dirname, '..');
  const result = spawnSync(process.execPath, ['-e', [
    "const config = require('./src/config');",
    'process.stdout.write(JSON.stringify({',
    'source: config.productSource,',
    "hasCsvPath: Object.hasOwn(config, 'productCsvPath'),",
    "hasCsvFallback: Object.hasOwn(config.haravan, 'fallbackToCsv')",
    '}));'
  ].join('')], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PRODUCT_SOURCE: 'csv',
      PRODUCT_CSV_PATH: './data/products.csv',
      HARAVAN_FALLBACK_TO_CSV: 'true'
    },
    encoding: 'utf8'
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    source: 'haravan',
    hasCsvPath: false,
    hasCsvFallback: false
  });
});

test('ProductService không còn đọc hoặc phân tích file CSV', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'productService.js'), 'utf8');
  assert.doesNotMatch(source, /readFileSync|forEachCsvObject|replaceProducts\([^)]*,\s*['"]csv['"]\)/);
});
