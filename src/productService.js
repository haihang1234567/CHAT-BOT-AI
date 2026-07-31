const fs = require('fs');
const { SLANG_EXPANSION_TOKENS } = require('./chatSlangNormalizer');
const { cosineSimilarity } = require('./embeddingService');


function forEachCsvObject(input, callback) {
  const text = String(input || '').replace(/^\uFEFF/, '');
  let headers = null;
  let row = [];
  let field = '';
  let quoted = false;

  const consumeRow = () => {
    if (!row.some((value) => value !== '')) {
      row = [];
      return;
    }

    if (!headers) {
      headers = row.map((header) => header.trim());
    } else {
      const object = {};
      headers.forEach((header, index) => { object[header] = row[index] ?? ''; });
      callback(object);
    }
    row = [];
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field.replace(/\r$/, ''));
      field = '';
      consumeRow();
    } else {
      field += char;
    }
  }

  row.push(field.replace(/\r$/, ''));
  consumeRow();
}

function clean(value) {
  if (value === null || value === undefined) return '';
  const text = String(value).trim();
  return ['nan', 'null', 'undefined'].includes(text.toLowerCase()) ? '' : text;
}

function numberValue(value) {
  const parsed = Number(String(value ?? '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeText(value) {
  return clean(value)
    .replace(/,/g, '.')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function canonicalSearchText(value) {
  let text = normalizeText(value);
  const replacements = [
    [/\b(?:pick|pickle|pickball|pickeball|pickelball|picleball|picklebal|pkl)\b/g, 'pickleball'],
    [/\b(?:volley|volleyball)\b/g, 'bong chuyen'],
    [/\bbadminton\b/g, 'cau long'],
    [/\b(?:soccer|football)\b/g, 'bong da'],
    [/\bda bong\b/g, 'bong da'],
    [/\b(?:running|jogging)\b/g, 'chay bo'],
    [/\bbasketball\b/g, 'bong ro'],
    [/\b(?:table tennis|ping pong|pingpong)\b/g, 'bong ban'],
    [/\b(?:shoe|shoes|sneaker|sneakers)\b/g, 'giay']
  ];
  for (const [pattern, replacement] of replacements) {
    text = text.replace(pattern, replacement);
  }
  return text.replace(/\s+/g, ' ').trim();
}

function stripHtml(html) {
  return clean(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function editDistance(left, right) {
  const a = String(left || '');
  const b = String(right || '');
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let row = 1; row <= a.length; row += 1) {
    let diagonal = previous[0];
    previous[0] = row;
    for (let column = 1; column <= b.length; column += 1) {
      const above = previous[column];
      previous[column] = Math.min(
        previous[column] + 1,
        previous[column - 1] + 1,
        diagonal + (a[row - 1] === b[column - 1] ? 0 : 1)
      );
      diagonal = above;
    }
  }
  return previous[b.length];
}

function termInText(text, rawTerm) {
  const term = canonicalSearchText(rawTerm);
  if (!term) return false;
  if (/^[a-z0-9]{1,3}$/.test(term)) {
    return new RegExp(`(?:^|\\s)${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|\\s)`).test(text);
  }
  return text.includes(term);
}

function parsePriceIntent(rawQuery) {
  const q = normalizeText(rawQuery).replace(/,/g, '.');
  const toMoney = (num, unit) => {
    const value = Number(num);
    if (!Number.isFinite(value)) return null;
    if (/trieu|m\b/.test(unit || '')) return value * 1_000_000;
    if (/nghin|k\b/.test(unit || '')) return value * 1_000;
    if (!unit && value >= 100 && value <= 10000) return value * 1_000;
    return value;
  };

  const range = q.match(/(\d+(?:\.\d+)?)\s*(trieu|m|nghin|k)?\s*(?:-|den|toi)\s*(\d+(?:\.\d+)?)\s*(trieu|m|nghin|k)?/);
  if (range) {
    const unit1 = range[2] || range[4] || '';
    const unit2 = range[4] || range[2] || '';
    return { min: toMoney(range[1], unit1), max: toMoney(range[3], unit2) };
  }

  const single = q.match(/(\d+(?:\.\d+)?)\s*(trieu|m|nghin|k)\b/);
  if (!single) return null;
  const value = toMoney(single[1], single[2]);
  if (/duoi|khong qua|toi da/.test(q)) return { max: value };
  if (/tren|tu/.test(q)) return { min: value };
  return { min: value * 0.75, max: value * 1.25, target: value };
}

function formatVnd(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number <= 0) return 'chưa có giá';
  return `${Math.round(number).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.')}₫`;
}

function catalogProductKind(value) {
  const text = canonicalSearchText(value);
  if (/(?:^|\s)vot(?:\s|$)/.test(text)) return 'racket';
  if (/(?:^|\s)giay(?:\s|$)/.test(text)) return 'shoe';
  if (/(?:^|\s)(?:ao|polo|tee|jacket)(?:\s|$)/.test(text)) return 'shirt';
  if (/(?:^|\s)(?:quan|short)(?:\s|$)/.test(text)) return 'pants';
  if (/(?:^|\s)(?:balo|ba lo|tui)(?:\s|$)/.test(text)) return 'bag';
  if (/(?:^|\s)(?:qua bong|bong thi dau)(?:\s|$)/.test(text)) return 'ball';
  return 'other';
}

class ProductService {
  constructor(csvPath, shopDomain, options = {}) {
    this.csvPath = csvPath;
    this.shopDomain = shopDomain;
    this.products = [];
    this.productById = new Map();
    this.variantById = new Map();
    this.codeIndex = new Map();
    this.catalogVocabulary = new Set();
    this.brandNames = [];
    this.source = 'empty';
    this.lastLoadedAt = null;
    this.embeddingService = options.embeddingService || null;
    this._catalogSummary = this.buildCatalogSummary();
    if (options.loadCsv !== false) this.load();
  }

  load() {
    if (!fs.existsSync(this.csvPath)) {
      throw new Error(`Không tìm thấy file CSV: ${this.csvPath}`);
    }

    const grouped = new Map();
    let rowCount = 0;
    forEachCsvObject(fs.readFileSync(this.csvPath, 'utf8'), (row) => {
      rowCount += 1;
      const productId = clean(row['Mã sản phẩm']);
      if (!productId) return;

      let product = grouped.get(productId);
      if (!product) {
        const slug = clean(row['Url']);
        product = {
          id: productId,
          name: clean(row['Tên']) || `Sản phẩm ${productId}`,
          slug,
          url: slug ? `${this.shopDomain}/products/${slug.replace(/^\/+/, '')}` : this.shopDomain,
          brand: clean(row['Hãng']),
          type: clean(row['Loại sản phẩm']),
          tags: clean(row['Tag']),
          description: stripHtml(row['Mô tả']),
          excerpt: clean(row['Trích dẫn']) || clean(row['SEO Description']),
          images: [],
          variants: []
        };
        grouped.set(productId, product);
      }

      const color = this.pickAttribute(row, ['Màu', 'Màu sắc', 'Color']);
      const size = this.pickAttribute(row, ['Size', 'Kích thước', 'Kích cỡ']);
      const variant = {
        id: clean(row['Mã biến thể']),
        sku: clean(row['Mã phiên bản sản phẩm']),
        barcode: clean(row['Barcode']),
        color,
        size,
        quantity: numberValue(row['Số lượng tồn kho']),
        inStock: numberValue(row['Số lượng tồn kho']) > 0,
        price: numberValue(row['Giá']),
        compareAtPrice: numberValue(row['Giá so sánh']),
        image: clean(row['Ảnh biến thể']) || clean(row['Link hình'])
      };

      product.variants.push(variant);
      product.images.push(clean(row['Ảnh biến thể']), clean(row['Link hình']));
    });

    this.replaceProducts([...grouped.values()], 'csv');
    console.log(`Đã nạp ${rowCount} dòng biến thể / ${this.products.length} sản phẩm từ CSV.`);
  }

  replaceProducts(products, source = 'memory') {
    const finalized = (Array.isArray(products) ? products : [])
      .map((product) => this.finalizeProduct({
        ...product,
        id: clean(product.id),
        name: clean(product.name),
        slug: clean(product.slug),
        url: clean(product.url) || this.shopDomain,
        brand: clean(product.brand),
        type: clean(product.type),
        tags: clean(product.tags),
        description: clean(product.description),
        excerpt: clean(product.excerpt),
        images: Array.isArray(product.images) ? product.images : [],
        variants: (Array.isArray(product.variants) ? product.variants : []).map((variant) => ({
          ...variant,
          id: clean(variant.id),
          sku: clean(variant.sku),
          barcode: clean(variant.barcode),
          color: clean(variant.color),
          size: clean(variant.size),
          quantity: numberValue(variant.quantity),
          inStock: Boolean(variant.inStock),
          price: numberValue(variant.price),
          compareAtPrice: numberValue(variant.compareAtPrice),
          image: clean(variant.image)
        })),
        collections: Array.isArray(product.collections) ? product.collections : [],
        collectionHandles: Array.isArray(product.collectionHandles) ? product.collectionHandles : []
      }))
      .filter((product) => product.id);

    const nextProductById = new Map();
    const nextVariantById = new Map();
    const nextCodeIndex = new Map();
    const addCode = (code, result) => {
      const normalized = normalizeText(code).replace(/\s/g, '');
      if (normalized) nextCodeIndex.set(normalized, result);
    };

    for (const product of finalized) {
      nextProductById.set(product.id, product);
      addCode(product.id, { product, variant: null });
      for (const variant of product.variants) {
        if (variant.id) {
          nextVariantById.set(String(variant.id), { product, variant });
          addCode(variant.id, { product, variant });
        }
        if (variant.sku) addCode(variant.sku, { product, variant });
        if (variant.barcode) addCode(variant.barcode, { product, variant });
      }
    }

    // Chỉ thay toàn bộ chỉ mục sau khi dữ liệu mới đã được dựng xong.
    this.products = finalized;
    this.productById = nextProductById;
    this.variantById = nextVariantById;
    this.codeIndex = nextCodeIndex;
    this.catalogVocabulary = new Set();
    this.brandNames = unique(finalized.map((product) => canonicalSearchText(product.brand)));
    for (const product of finalized) {
      const identityFields = [
        product.brand,
        product.type,
        ...(product.collections || []),
        ...(product.collectionHandles || [])
      ];
      for (const field of identityFields) {
        for (const token of canonicalSearchText(field).split(' ')) {
          if (token.length >= 3 && !/\d/.test(token)) this.catalogVocabulary.add(token);
        }
      }
    }
    this.source = source;
    this.lastLoadedAt = new Date().toISOString();
    this._catalogSummary = this.buildCatalogSummary();
  }

  status() {
    return {
      source: this.source,
      productCount: this.products.length,
      variantCount: this.products.reduce((sum, product) => sum + product.variants.length, 0),
      lastLoadedAt: this.lastLoadedAt,
      embeddings: this.embeddingStatus()
    };
  }

  embeddingStatus() {
    return this.embeddingService?.status?.() || {
      enabled: false,
      configured: false,
      vectorCount: 0
    };
  }

  catalogBrands() {
    return [...this.brandNames];
  }

  buildCatalogSummary() {
    const availableProducts = (this.products || []).filter((product) => (
      (product.variants || []).some((variant) => variant.inStock)
    ));
    const typeMap = new Map();
    const brandMap = new Map();
    const catalogPrices = [];

    for (const product of availableProducts) {
      const inStockPrices = (product.variants || [])
        .filter((variant) => variant.inStock && Number(variant.price) > 0)
        .map((variant) => Number(variant.price));
      catalogPrices.push(...inStockPrices);

      const typeName = clean(product.type);
      const typeKey = canonicalSearchText(typeName);
      if (typeKey) {
        const current = typeMap.get(typeKey) || {
          name: typeName,
          normalized: typeKey,
          kind: catalogProductKind(typeName),
          count: 0,
          prices: []
        };
        current.count += 1;
        current.prices.push(...inStockPrices);
        typeMap.set(typeKey, current);
      }

      const brandName = clean(product.brand);
      const brandKey = canonicalSearchText(brandName);
      if (brandKey) {
        const current = brandMap.get(brandKey) || {
          name: brandName,
          normalized: brandKey,
          count: 0
        };
        current.count += 1;
        brandMap.set(brandKey, current);
      }
    }

    const priceRange = (prices) => ({
      min: prices.length ? Math.min(...prices) : 0,
      max: prices.length ? Math.max(...prices) : 0
    });
    const typeStats = [...typeMap.values()]
      .map(({ prices, ...type }) => ({ ...type, ...priceRange(prices) }))
      .sort((left, right) => left.name.localeCompare(right.name, 'vi'));
    const brandStats = [...brandMap.values()]
      .sort((left, right) => left.name.localeCompare(right.name, 'vi'));
    const catalogPriceRange = priceRange(catalogPrices);
    const typeLines = typeStats.map((type) => (
      `- ${type.name}: ${type.count} sản phẩm, giá ${formatVnd(type.min)}–${formatVnd(type.max)}`
    ));
    const brandText = brandStats.length
      ? brandStats.map((brand) => `${brand.name} (${brand.count})`).join(', ')
      : 'chưa có';
    const text = [
      `CATALOG HIỆN CÓ (tổng ${availableProducts.length} sản phẩm còn hàng):`,
      ...typeLines,
      `Thương hiệu: ${brandText}`,
      `Giá toàn catalog: ${formatVnd(catalogPriceRange.min)}–${formatVnd(catalogPriceRange.max)}`
    ].join('\n');

    return {
      totalProducts: availableProducts.length,
      types: typeStats.map((type) => type.name),
      typeStats,
      brands: brandStats,
      priceMin: catalogPriceRange.min,
      priceMax: catalogPriceRange.max,
      text
    };
  }

  getCatalogSummary() {
    return this._catalogSummary;
  }

  catalogTypes(kind = '') {
    const stats = this.getCatalogSummary()?.typeStats || [];
    return stats
      .filter((type) => !kind || type.kind === kind)
      .map((type) => type.name);
  }

  matchCatalogTypes(rawQuery, options = {}) {
    const query = canonicalSearchText(rawQuery);
    if (!query) return [];
    const kind = clean(options.kind);
    const ignoredTokens = new Set([
      'giay', 'vot', 'qua', 'ao', 'quan', 'balo', 'ba', 'lo', 'tui',
      'phu', 'kien', 'the', 'thao', 'nam', 'nu', 'san', 'pham', 'khac'
    ]);
    const queryWords = new Set(query.split(' ').filter(Boolean));

    return (this.getCatalogSummary()?.typeStats || [])
      .filter((type) => !kind || type.kind === kind)
      .filter((type) => {
        if (termInText(query, type.normalized)) return true;
        const distinctive = type.normalized
          .split(' ')
          .filter((token) => token.length > 1 && !ignoredTokens.has(token));
        return distinctive.length > 0 && distinctive.every((token) => queryWords.has(token));
      })
      .map((type) => type.name);
  }

  normalizeCatalogQuery(rawQuery) {
    const original = clean(rawQuery);
    const canonical = canonicalSearchText(original);
    if (!canonical || !this.catalogVocabulary.size) {
      return { query: canonical || original, corrections: [], ambiguous: [] };
    }

    const corrections = [];
    const ambiguous = [];
    const protectedWords = new Set([
      'admin', 'anh', 'ban', 'bao', 'cho', 'con', 'duoi', 'gia', 'hang',
      'khong', 'mau', 'muon', 'nao', 'size', 'tham', 'them', 'tren', 'xem',
      ...SLANG_EXPANSION_TOKENS
    ]);
    const correctedTokens = canonical.split(' ').map((token) => {
      const exactCode = normalizeText(token).replace(/\s/g, '');
      if (
        token.length < 3
        || /\d/.test(token)
        || this.codeIndex.has(exactCode)
        || protectedWords.has(token)
        || this.catalogVocabulary.has(token)
      ) return token;

      const ranked = [...this.catalogVocabulary]
        .map((candidate) => {
          const prefix = candidate.startsWith(token) && token.length >= 3;
          return {
            candidate,
            distance: prefix ? Math.min(1, candidate.length - token.length) : editDistance(token, candidate),
            prefix
          };
        })
        .filter((item) => {
          const allowed = Math.max(token.length, item.candidate.length) >= 7 ? 2 : 1;
          return item.prefix || item.distance <= allowed;
        })
        .sort((a, b) => Number(b.prefix) - Number(a.prefix)
          || a.distance - b.distance
          || a.candidate.length - b.candidate.length);
      if (!ranked.length) return token;

      const best = ranked[0];
      const tied = ranked.filter((item) => (
        item.prefix === best.prefix && item.distance === best.distance
      ));
      if (tied.length > 1) {
        ambiguous.push({ input: token, options: tied.slice(0, 3).map((item) => item.candidate) });
        return token;
      }
      if (best.candidate !== token) corrections.push({ input: token, output: best.candidate });
      return best.candidate;
    });

    return {
      query: correctedTokens.join(' '),
      corrections,
      ambiguous
    };
  }

  pickAttribute(row, acceptedNames) {
    for (let index = 1; index <= 3; index += 1) {
      const key = clean(row[`Thuộc tính ${index}`]);
      if (!key) continue;
      const normalizedKey = normalizeText(key);
      if (acceptedNames.some((name) => {
        const acceptedName = normalizeText(name);
        return normalizedKey === acceptedName || normalizedKey.startsWith(`${acceptedName} `);
      })) {
        return clean(row[`Giá trị thuộc tính ${index}`]);
      }
    }
    return '';
  }

  finalizeProduct(product) {
    product.images = unique(product.images);
    product.colors = unique(product.variants.map((variant) => variant.color));
    product.sizes = unique(product.variants.map((variant) => variant.size));
    product.inStock = product.variants.some((variant) => variant.inStock);

    const pricedVariants = product.variants.filter((variant) => variant.price > 0);
    const priceSource = pricedVariants.length ? pricedVariants : product.variants;
    const prices = priceSource.map((variant) => variant.price).filter((price) => price > 0);
    const compares = priceSource.map((variant) => variant.compareAtPrice).filter((price) => price > 0);
    product.priceMin = prices.length ? Math.min(...prices) : 0;
    product.priceMax = prices.length ? Math.max(...prices) : 0;
    product.compareAtMin = compares.length ? Math.min(...compares) : 0;
    product.compareAtMax = compares.length ? Math.max(...compares) : 0;
    product.hasSale = product.variants.some(
      (variant) => variant.compareAtPrice > variant.price && variant.price > 0
    );
    product.identityText = canonicalSearchText([
      product.name,
      product.brand,
      product.type,
      product.tags,
      product.slug,
      ...(product.collections || []),
      ...(product.collectionHandles || [])
    ].join(' '));
    product.searchText = canonicalSearchText([
      product.name,
      product.brand,
      product.type,
      product.tags,
      ...(product.collections || []),
      ...(product.collectionHandles || []),
      product.excerpt,
      product.description.slice(0, 2500),
      ...product.variants.flatMap((variant) => [variant.id, variant.sku, variant.barcode, variant.color, variant.size])
    ].join(' '));
    return product;
  }

  addCode(code, result) {
    const normalized = normalizeText(code).replace(/\s/g, '');
    if (normalized) this.codeIndex.set(normalized, result);
  }

  publicProduct(product, matchedVariant = null) {
    return {
      id: product.id,
      name: product.name,
      url: product.url,
      brand: product.brand,
      type: product.type,
      collections: product.collections || [],
      excerpt: product.excerpt,
      description: product.description,
      images: product.images,
      colors: product.colors,
      sizes: product.sizes,
      inStock: product.inStock,
      priceMin: product.priceMin,
      priceMax: product.priceMax,
      compareAtMin: product.compareAtMin,
      compareAtMax: product.compareAtMax,
      hasSale: product.hasSale,
      matchedVariantId: matchedVariant?.id || null,
      variants: product.variants
    };
  }

  getProduct(productId) {
    const product = this.productById.get(String(productId));
    return product ? this.publicProduct(product) : null;
  }

  getVariant(variantId) {
    return this.variantById.get(String(variantId)) || null;
  }

  exactLookup(query) {
    const normalized = normalizeText(query).replace(/\s/g, '');
    if (!normalized) return null;
    const direct = this.codeIndex.get(normalized);
    if (direct) return direct;

    const tokens = normalizeText(query).split(' ').filter(Boolean);
    for (const token of tokens) {
      const candidate = this.codeIndex.get(token.replace(/\s/g, ''));
      if (candidate) return candidate;
    }
    return null;
  }

  search(rawQuery, limit = 8) {
    const query = clean(rawQuery);
    if (!query) return [];

    const exact = this.exactLookup(query);
    if (exact) return [this.publicProduct(exact.product, exact.variant)];

    const normalized = canonicalSearchText(query);
    const stopWords = new Set(['co', 'gi', 'nao', 'cho', 'toi', 'tim', 'can', 'muon', 'gia', 'bao', 'nhieu', 'tien', 'tam', 'khoang', 'duoi', 'tren', 'tu', 'den', 'san', 'pham', 'tu', 'van', 'goi', 'y', 'xem', 'chi', 'tiet']);
    const tokens = normalized.split(' ').filter((token) => token.length > 1 && !stopWords.has(token));
    const priceIntent = parsePriceIntent(query);
    const matchedCatalogTypes = this.matchCatalogTypes(query).map(canonicalSearchText);

    const scored = this.products.map((product) => {
      let score = 0;
      const normalizedName = normalizeText(product.name);
      if (normalizedName === normalized) score += 500;
      if (normalizedName.includes(normalized)) score += 180;
      if (product.searchText.includes(normalized)) score += 80;

      for (const token of tokens) {
        if (normalizedName.includes(token)) score += 25;
        else if (product.searchText.includes(token)) score += 7;
        else score -= 3;
      }

      for (const phrase of matchedCatalogTypes) {
        if (product.searchText.includes(phrase)) score += 140;
        else score -= 220;
      }

      if (priceIntent && product.priceMin > 0) {
        const price = product.priceMin;
        const withinMin = !priceIntent.min || price >= priceIntent.min;
        const withinMax = !priceIntent.max || price <= priceIntent.max;
        if (withinMin && withinMax) score += 70;
        else score -= 30;
        if (priceIntent.target) {
          const distance = Math.abs(price - priceIntent.target) / priceIntent.target;
          score += Math.max(0, 40 - distance * 80);
        }
      }

      if (product.inStock) score += 4;
      return { product, score };
    });

    return scored
      .filter((item) => item.score > 4)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((item) => this.publicProduct(item.product));
  }

  async semanticSearch(rawQuery, limit = 8) {
    const query = clean(rawQuery);
    if (
      !query
      || !this.embeddingService?.embedText
      || !this.embeddingService?.getVector
      || this.embeddingService?.isConfigured?.() === false
    ) return [];
    const hasProductVectors = this.products.some((product) => (
      Array.isArray(this.embeddingService.getVector(product.id))
    ));
    if (!hasProductVectors) return [];

    const queryVector = await this.embeddingService.embedText(query, 'query');
    const minScore = Number(this.embeddingService.config?.minScore ?? -1);
    return this.products
      .map((product) => ({
        product,
        score: cosineSimilarity(queryVector, this.embeddingService.getVector(product.id))
      }))
      .filter((item) => item.score >= minScore)
      .sort((left, right) => right.score - left.score)
      .slice(0, Math.max(1, Number(limit || 8)))
      .map((item) => ({
        ...this.publicProduct(item.product),
        semanticScore: item.score
      }));
  }

  semanticQueryText(plan = {}, fallbackQuery = '') {
    const search = plan?.search && typeof plan.search === 'object' ? plan.search : plan;
    return clean([
      search.query || fallbackQuery,
      ...(search.customerNeeds || []),
      ...(search.requirements || []).flatMap((group) => [group?.label, ...(group?.terms || [])]),
      ...(search.preferences || []).flatMap((group) => [group?.label, ...(group?.terms || [])])
    ].join(' '));
  }

  async hybridQueryByPlan(plan = {}, fallbackQuery = '', limit = 5) {
    const search = plan?.search && typeof plan.search === 'object' ? plan.search : plan;
    const safeLimit = Math.max(1, Math.min(12, Number(search.limit || limit || 5)));
    const candidateLimit = Math.max(12, Math.min(40, safeLimit * 4));
    const candidatePlan = {
      ...plan,
      search: { ...search, limit: candidateLimit }
    };
    const keywordResults = this.queryByPlan(candidatePlan, fallbackQuery, candidateLimit);
    const exactRequest = (search.codes || []).length
      || (search.productIds || []).length
      || this.exactLookup(search.query || fallbackQuery);
    const keywordSignalCount = this.search(
      this.semanticQueryText(plan, fallbackQuery),
      3
    ).length;
    const shouldUseSemantic = !exactRequest && (
      keywordResults.length < 3
      || keywordSignalCount < 3
      || plan?.responseMode === 'recommend'
    );
    if (!shouldUseSemantic) return keywordResults.slice(0, safeLimit);

    let semanticResults;
    try {
      semanticResults = await this.semanticSearch(
        this.semanticQueryText(plan, fallbackQuery),
        candidateLimit
      );
    } catch (error) {
      console.warn(`[SEMANTIC_SEARCH] Dùng kết quả từ khóa vì Voyage lỗi: ${error.message}`);
      return keywordResults.slice(0, safeLimit);
    }
    if (!semanticResults.length) return keywordResults.slice(0, safeLimit);

    const validatedSemantic = [];
    for (const semanticProduct of semanticResults) {
      const validationPlan = {
        ...plan,
        search: {
          ...search,
          codes: [],
          productIds: [semanticProduct.id],
          limit: 1
        }
      };
      const [validated] = this.queryByPlan(validationPlan, fallbackQuery, 1, {
        strictFilters: true
      });
      if (validated?.id === semanticProduct.id) {
        validatedSemantic.push({ ...validated, semanticScore: semanticProduct.semanticScore });
      }
    }

    const fused = new Map();
    const addRanked = (items, source) => {
      items.forEach((product, index) => {
        const current = fused.get(product.id) || { product, score: 0 };
        current.score += 1 / (60 + index + 1);
        if (source === 'semantic' && Number.isFinite(product.semanticScore)) {
          current.score += Math.max(0, product.semanticScore) * 0.02;
        }
        fused.set(product.id, current);
      });
    };
    addRanked(keywordResults, 'keyword');
    addRanked(validatedSemantic, 'semantic');
    return [...fused.values()]
      .sort((left, right) => right.score - left.score)
      .slice(0, safeLimit)
      .map((item) => item.product);
  }

  normalizedList(value) {
    return Array.isArray(value)
      ? value.map(canonicalSearchText).filter(Boolean)
      : [];
  }

  normalizedNeedGroups(value) {
    if (!Array.isArray(value)) return [];
    return value
      .map((group) => ({
        label: clean(group?.label),
        terms: this.normalizedList(group?.terms),
        scope: group?.scope === 'identity' ? 'identity' : 'details'
      }))
      .filter((group) => group.terms.length);
  }

  productMatchesNeedGroup(product, group) {
    const haystack = group.scope === 'identity' ? product.identityText : product.searchText;
    return group.terms.some((term) => termInText(haystack, term));
  }

  variantMatchesPlan(variant, filters) {
    if (filters.inStockOnly && !variant.inStock) return false;

    if (filters.colors.length) {
      const color = normalizeText(variant.color);
      if (!filters.colors.some((wanted) => color.includes(wanted) || wanted.includes(color))) return false;
    }

    if (filters.sizes.length) {
      const size = normalizeText(variant.size).replace(/\s/g, '');
      if (!filters.sizes.some((wanted) => {
        const normalizedWanted = wanted.replace(/\s/g, '');
        return size === normalizedWanted || size.includes(normalizedWanted) || normalizedWanted.includes(size);
      })) return false;
    }

    const price = Number(variant.price || 0);
    if (filters.minPrice !== null && price < filters.minPrice) return false;
    if (filters.maxPrice !== null && price > filters.maxPrice) return false;
    return true;
  }

  bestVariantForPlan(product, filters) {
    const matches = product.variants.filter((variant) => this.variantMatchesPlan(variant, filters));
    const source = matches.length ? matches : product.variants;
    const target = filters.minPrice !== null && filters.maxPrice !== null
      ? (filters.minPrice + filters.maxPrice) / 2
      : filters.minPrice ?? filters.maxPrice;

    return [...source].sort((a, b) => {
      if (a.inStock !== b.inStock) return a.inStock ? -1 : 1;
      if (target !== null && target !== undefined) {
        return Math.abs((a.price || 0) - target) - Math.abs((b.price || 0) - target);
      }
      return (a.price || 0) - (b.price || 0);
    })[0] || null;
  }

  queryByPlan(plan = {}, fallbackQuery = '', limit = 5, options = {}) {
    const search = plan?.search && typeof plan.search === 'object' ? plan.search : plan;
    const filters = {
      query: clean(search.query || fallbackQuery),
      productIds: unique((search.productIds || []).map(clean)),
      excludeProductIds: unique((search.excludeProductIds || []).map(clean)),
      codes: unique([...(search.codes || []), ...(search.productIds || [])].map(clean)),
      names: this.normalizedList(search.names),
      brands: this.normalizedList(search.brands),
      categories: this.normalizedList(search.categories),
      colors: this.normalizedList(search.colors),
      sizes: this.normalizedList(search.sizes),
      requirements: this.normalizedNeedGroups(search.requirements),
      preferences: this.normalizedNeedGroups(search.preferences),
      excludeTerms: this.normalizedList(search.excludeTerms),
      minPrice: search.minPrice !== null && search.minPrice !== undefined && search.minPrice !== '' && Number.isFinite(Number(search.minPrice))
        ? Number(search.minPrice)
        : null,
      maxPrice: search.maxPrice !== null && search.maxPrice !== undefined && search.maxPrice !== '' && Number.isFinite(Number(search.maxPrice))
        ? Number(search.maxPrice)
        : null,
      inStockOnly: Boolean(search.inStockOnly)
    };
    const safeLimit = Math.max(1, Math.min(12, Number(search.limit || limit || 5)));
    const exactResults = [];
    const exactIds = new Set();

    for (const code of filters.codes) {
      const found = this.exactLookup(code);
      if (found && !exactIds.has(found.product.id)) {
        exactIds.add(found.product.id);
        exactResults.push({ product: found.product, variant: found.variant, score: 5000 });
      }
    }

    // Truy vấn chữ tự do chỉ dùng để tạo tập ứng viên; bộ lọc cấu trúc vẫn được code kiểm tra lại.
    const textQuery = clean([
      filters.query,
      ...(search.names || []),
      ...(search.brands || []),
      ...(search.categories || []),
      ...(search.colors || []),
      ...(search.sizes || []),
      ...(search.requirements || []).flatMap((group) => group?.terms || []),
      ...(search.preferences || []).flatMap((group) => group?.terms || [])
    ].join(' '));
    const searchCandidates = textQuery ? this.search(textQuery, 40) : [];
    const candidateIds = new Set(searchCandidates.map((item) => item.id));
    exactResults.forEach((item) => candidateIds.add(item.product.id));

    const hasStructuredFilters = filters.names.length || filters.brands.length || filters.categories.length
      || filters.colors.length || filters.sizes.length || filters.minPrice !== null
      || filters.maxPrice !== null || filters.inStockOnly || filters.requirements.length
      || filters.excludeTerms.length;
    const pool = filters.productIds.length
      ? [...exactIds].map((id) => this.productById.get(id)).filter(Boolean)
      : candidateIds.size && !hasStructuredFilters
        ? [...candidateIds].map((id) => this.productById.get(id)).filter(Boolean)
        : this.products;

    const scored = [];
    for (const product of pool) {
      if (filters.excludeProductIds.includes(String(product.id))) continue;
      const productName = normalizeText(product.name);
      const brand = normalizeText(product.brand);
      const searchable = product.searchText;
      let score = exactIds.has(product.id) ? 5000 : 0;

      if (filters.brands.length) {
        const matched = filters.brands.some((wanted) => brand.includes(wanted) || productName.includes(wanted));
        if (!matched) continue;
        score += 180;
      }

      if (filters.categories.length) {
        const matched = filters.categories.some((wanted) => searchable.includes(wanted));
        if (!matched) continue;
        score += 150;
      }

      if (filters.names.length) {
        const matched = filters.names.some((wanted) => {
          if (productName.includes(wanted)) return true;
          const tokens = wanted.split(' ').filter((token) => token.length > 1);
          return tokens.length > 0 && tokens.every((token) => productName.includes(token) || searchable.includes(token));
        });
        if (!matched) continue;
        score += 250;
      }

      if (filters.excludeTerms.some((term) => termInText(product.identityText, term))) continue;
      if (filters.requirements.some((group) => !this.productMatchesNeedGroup(product, group))) continue;

      const matchingVariants = product.variants.filter((variant) => this.variantMatchesPlan(variant, filters));
      const hasVariantFilters = filters.colors.length || filters.sizes.length || filters.minPrice !== null
        || filters.maxPrice !== null || filters.inStockOnly;
      if (hasVariantFilters && !matchingVariants.length) continue;

      if (filters.colors.length) score += 120;
      if (filters.sizes.length) score += 120;
      if (filters.minPrice !== null || filters.maxPrice !== null) score += 90;
      for (const preference of filters.preferences) {
        if (this.productMatchesNeedGroup(product, preference)) score += 80;
      }
      if (product.inStock) score += 10;

      if (filters.query) {
        const normalizedQuery = normalizeText(filters.query);
        if (productName.includes(normalizedQuery)) score += 250;
        const tokens = normalizedQuery.split(' ').filter((token) => token.length > 1);
        for (const token of tokens) {
          if (productName.includes(token)) score += 16;
          else if (searchable.includes(token)) score += 4;
        }
      }

      const matchedVariant = this.bestVariantForPlan(product, filters);
      scored.push({ product, matchedVariant, score });
    }

    let results = scored
      .sort((a, b) => b.score - a.score || a.product.priceMin - b.product.priceMin)
      .slice(0, safeLimit)
      .map(({ product, matchedVariant }) => this.publicProduct(product, matchedVariant));

    if (!results.length && exactResults.length && !options.strictFilters) {
      results = exactResults.slice(0, safeLimit).map(({ product, variant }) => this.publicProduct(product, variant));
    }

    // Nếu AI bóc tách quá chặt làm rỗng kết quả, fallback sang tìm kiếm chữ để chatbot không bị “cụt”.
    const hasHardFilters = Boolean(
      filters.categories.length || filters.colors.length || filters.sizes.length
      || filters.minPrice !== null || filters.maxPrice !== null || filters.inStockOnly
      || filters.requirements.length || filters.excludeTerms.length
    );
    if (!results.length && !hasHardFilters && textQuery) results = this.search(textQuery, safeLimit);
    if (!results.length && !hasHardFilters && fallbackQuery) results = this.search(fallbackQuery, safeLimit);
    return results;
  }

  compactForAi(products, rawQuery = '', options = {}) {
    const maxProducts = Math.max(1, Number(options.maxProducts || 3));
    const maxVariants = Math.max(1, Number(options.maxVariants || 10));
    const descriptionChars = Math.max(100, Number(options.descriptionChars || 650));
    const includeVariants = options.includeVariants !== false;
    const maxColors = Math.max(1, Number(options.maxColors || 8));
    const maxSizes = Math.max(1, Number(options.maxSizes || 14));
    const query = normalizeText(rawQuery);
    const queryTokens = query.split(' ').filter((token) => token.length > 1);

    return products.slice(0, maxProducts).map((product) => {
      const rankedVariants = includeVariants ? product.variants
        .map((variant, index) => {
          const fields = [variant.id, variant.sku, variant.barcode, variant.color, variant.size]
            .map(normalizeText)
            .filter(Boolean);
          let score = variant.inStock ? 1 : 0;
          for (const field of fields) {
            if (query && query.includes(field)) score += 30;
            for (const token of queryTokens) {
              if (field === token) score += 12;
              else if (field.includes(token)) score += 4;
            }
          }
          return { variant, score, index };
        })
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .slice(0, maxVariants)
        .map(({ variant }) => ({
          id: variant.id,
          sku: variant.sku,
          barcode: variant.barcode,
          color: variant.color,
          size: variant.size,
          stock: variant.inStock ? 'Còn hàng' : 'Hết hàng',
          price: variant.price,
          originalPrice: variant.compareAtPrice
        })) : [];

      const compact = {
        id: product.id,
        name: product.name,
        brand: product.brand,
        type: product.type,
        stock: product.inStock ? 'Còn hàng' : 'Hết hàng',
        priceMin: product.priceMin,
        priceMax: product.priceMax,
        originalPriceMin: product.compareAtMin,
        originalPriceMax: product.compareAtMax,
        colors: product.colors.slice(0, maxColors),
        sizes: product.sizes.slice(0, maxSizes),
        description: (product.excerpt || product.description).slice(0, descriptionChars)
      };
      if (includeVariants) compact.variants = rankedVariants;
      return compact;
    });
  }
}

module.exports = { ProductService, normalizeText, canonicalSearchText };
