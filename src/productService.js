const fs = require('fs');


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
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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

function termInText(text, rawTerm) {
  const term = normalizeText(rawTerm);
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

class ProductService {
  constructor(csvPath, shopDomain) {
    this.csvPath = csvPath;
    this.shopDomain = shopDomain;
    this.products = [];
    this.productById = new Map();
    this.variantById = new Map();
    this.codeIndex = new Map();
    this.load();
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

    this.products = [...grouped.values()].map((product) => this.finalizeProduct(product));
    this.productById.clear();
    this.variantById.clear();
    this.codeIndex.clear();

    for (const product of this.products) {
      this.productById.set(product.id, product);
      this.addCode(product.id, { product, variant: null });
      for (const variant of product.variants) {
        if (variant.id) {
          this.variantById.set(variant.id, { product, variant });
          this.addCode(variant.id, { product, variant });
        }
        if (variant.sku) this.addCode(variant.sku, { product, variant });
        if (variant.barcode) this.addCode(variant.barcode, { product, variant });
      }
    }

    console.log(`Đã nạp ${rowCount} dòng biến thể / ${this.products.length} sản phẩm.`);
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
    product.identityText = normalizeText([
      product.name,
      product.brand,
      product.type,
      product.tags,
      product.slug
    ].join(' '));
    product.searchText = normalizeText([
      product.name,
      product.brand,
      product.type,
      product.tags,
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

    const normalized = normalizeText(query);
    const stopWords = new Set(['co', 'gi', 'nao', 'cho', 'toi', 'tim', 'can', 'muon', 'gia', 'bao', 'nhieu', 'tien', 'tam', 'khoang', 'duoi', 'tren', 'tu', 'den', 'san', 'pham', 'tu', 'van', 'goi', 'y', 'xem', 'chi', 'tiet']);
    const tokens = normalized.split(' ').filter((token) => token.length > 1 && !stopWords.has(token));
    const priceIntent = parsePriceIntent(query);
    const categoryPhrases = [
      'bong chuyen', 'bong da', 'cau long', 'chay bo', 'pickleball',
      'tennis', 'bong ro', 'san trong nha', 'san co nhan tao'
    ].filter((phrase) => normalized.includes(phrase));

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

      for (const phrase of categoryPhrases) {
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

  normalizedList(value) {
    return Array.isArray(value)
      ? value.map(normalizeText).filter(Boolean)
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

  queryByPlan(plan = {}, fallbackQuery = '', limit = 5) {
    const search = plan?.search && typeof plan.search === 'object' ? plan.search : plan;
    const filters = {
      query: clean(search.query || fallbackQuery),
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
    const pool = candidateIds.size && !hasStructuredFilters
      ? [...candidateIds].map((id) => this.productById.get(id)).filter(Boolean)
      : this.products;

    const scored = [];
    for (const product of pool) {
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

    if (!results.length && exactResults.length) {
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
    const query = normalizeText(rawQuery);
    const queryTokens = query.split(' ').filter((token) => token.length > 1);

    return products.slice(0, maxProducts).map((product) => {
      const rankedVariants = product.variants
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
        }));

      return {
        id: product.id,
        name: product.name,
        brand: product.brand,
        type: product.type,
        stock: product.inStock ? 'Còn hàng' : 'Hết hàng',
        priceMin: product.priceMin,
        priceMax: product.priceMax,
        originalPriceMin: product.compareAtMin,
        originalPriceMax: product.compareAtMax,
        colors: product.colors.slice(0, 20),
        sizes: product.sizes.slice(0, 30),
        variants: rankedVariants,
        description: (product.excerpt || product.description).slice(0, descriptionChars)
      };
    });
  }
}

module.exports = { ProductService, normalizeText };
