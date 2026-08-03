const { DatabaseSync } = require('node:sqlite');

function clean(value) {
  return String(value ?? '').trim();
}

function normalize(value) {
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

function normalizeCode(value) {
  return normalize(value).replace(/\s/g, '');
}

function unique(values) {
  return [...new Set((values || []).map(normalize).filter(Boolean))];
}

function positiveNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function placeholders(length) {
  return Array.from({ length }, () => '?').join(', ');
}

class CatalogDatabase {
  constructor(filename = ':memory:') {
    this.filename = filename || ':memory:';
    this.db = new DatabaseSync(this.filename);
    this.productCount = 0;
    this.variantCount = 0;
    this.lastRebuiltAt = null;
    this.initialize();
  }

  initialize() {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      DROP TABLE IF EXISTS variants;
      DROP TABLE IF EXISTS products;
      CREATE TABLE IF NOT EXISTS products (
        id TEXT PRIMARY KEY,
        normalized_id TEXT NOT NULL,
        name TEXT NOT NULL,
        normalized_name TEXT NOT NULL,
        brand TEXT NOT NULL,
        normalized_brand TEXT NOT NULL,
        type TEXT NOT NULL,
        normalized_type TEXT NOT NULL,
        identity_text TEXT NOT NULL,
        search_text TEXT NOT NULL,
        in_stock INTEGER NOT NULL,
        price_min REAL NOT NULL,
        price_max REAL NOT NULL
      );
      CREATE TABLE IF NOT EXISTS variants (
        id TEXT PRIMARY KEY,
        normalized_id TEXT NOT NULL,
        product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        sku TEXT NOT NULL,
        barcode TEXT NOT NULL,
        normalized_sku TEXT NOT NULL,
        normalized_barcode TEXT NOT NULL,
        color TEXT NOT NULL,
        normalized_color TEXT NOT NULL,
        size TEXT NOT NULL,
        normalized_size TEXT NOT NULL,
        price REAL NOT NULL,
        compare_at_price REAL NOT NULL,
        quantity REAL NOT NULL,
        in_stock INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_products_type ON products(normalized_type);
      CREATE INDEX IF NOT EXISTS idx_products_normalized_id ON products(normalized_id);
      CREATE INDEX IF NOT EXISTS idx_products_brand ON products(normalized_brand);
      CREATE INDEX IF NOT EXISTS idx_products_stock ON products(in_stock);
      CREATE INDEX IF NOT EXISTS idx_variants_product ON variants(product_id);
      CREATE INDEX IF NOT EXISTS idx_variants_normalized_id ON variants(normalized_id);
      CREATE INDEX IF NOT EXISTS idx_variants_sku ON variants(normalized_sku);
      CREATE INDEX IF NOT EXISTS idx_variants_barcode ON variants(normalized_barcode);
      CREATE INDEX IF NOT EXISTS idx_variants_color ON variants(normalized_color);
      CREATE INDEX IF NOT EXISTS idx_variants_size ON variants(normalized_size);
      CREATE INDEX IF NOT EXISTS idx_variants_price_stock ON variants(price, in_stock);
    `);
  }

  rebuild(products = []) {
    const insertProduct = this.db.prepare(`
      INSERT INTO products (
        id, normalized_id, name, normalized_name, brand, normalized_brand, type, normalized_type,
        identity_text, search_text, in_stock, price_min, price_max
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertVariant = this.db.prepare(`
      INSERT INTO variants (
        id, normalized_id, product_id, sku, barcode, normalized_sku, normalized_barcode,
        color, normalized_color, size, normalized_size, price,
        compare_at_price, quantity, in_stock
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec('DELETE FROM variants; DELETE FROM products;');
      let variantCount = 0;
      for (const product of products) {
        insertProduct.run(
          clean(product.id), normalizeCode(product.id), clean(product.name), normalize(product.name),
          clean(product.brand), normalize(product.brand), clean(product.type), normalize(product.type),
          clean(product.identityText), clean(product.searchText), product.inStock ? 1 : 0,
          Number(product.priceMin || 0), Number(product.priceMax || 0)
        );
        for (const variant of product.variants || []) {
          insertVariant.run(
            clean(variant.id), normalizeCode(variant.id), clean(product.id), clean(variant.sku), clean(variant.barcode),
            normalizeCode(variant.sku), normalizeCode(variant.barcode), clean(variant.color), normalize(variant.color),
            clean(variant.size), normalize(variant.size).replace(/\s/g, ''), Number(variant.price || 0),
            Number(variant.compareAtPrice || 0), Number(variant.quantity || 0), variant.inStock ? 1 : 0
          );
          variantCount += 1;
        }
      }
      this.db.exec('COMMIT');
      this.productCount = products.length;
      this.variantCount = variantCount;
      this.lastRebuiltAt = new Date().toISOString();
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  normalizePlan(search = {}) {
    return {
      productIds: [...new Set((search.productIds || []).map(normalizeCode).filter(Boolean))],
      excludeProductIds: [...new Set((search.excludeProductIds || []).map(normalizeCode).filter(Boolean))],
      codes: [...new Set((search.codes || []).map(normalizeCode).filter(Boolean))],
      names: unique(search.names),
      brands: unique(search.brands),
      categories: unique(search.categories),
      colors: unique(search.colors),
      sizes: unique(search.sizes).map((size) => size.replace(/\s/g, '')),
      excludeBrands: unique(search.excludeBrands),
      excludeCategories: unique(search.excludeCategories),
      excludeColors: unique(search.excludeColors),
      excludeSizes: unique(search.excludeSizes).map((size) => size.replace(/\s/g, '')),
      requirements: (Array.isArray(search.requirements) ? search.requirements : [])
        .map((group) => ({
          scope: group?.scope === 'identity' ? 'identity' : 'details',
          terms: unique(group?.terms)
        }))
        .filter((group) => group.terms.length),
      preferences: (Array.isArray(search.preferences) ? search.preferences : [])
        .map((group) => ({ terms: unique(group?.terms) }))
        .filter((group) => group.terms.length),
      excludeTerms: unique(search.excludeTerms),
      minPrice: positiveNumber(search.minPrice),
      maxPrice: positiveNumber(search.maxPrice),
      inStockOnly: Boolean(search.inStockOnly),
      query: normalize(search.query)
    };
  }

  query(search = {}, options = {}) {
    const filters = this.normalizePlan(search);
    const limit = Math.max(1, Math.min(50, Number(options.limit || search.limit || 5)));
    const where = [];
    const params = [];
    const scores = [];
    const scoreParams = [];

    if (filters.productIds.length) {
      where.push(`p.normalized_id IN (${placeholders(filters.productIds.length)})`);
      params.push(...filters.productIds);
    }
    if (filters.excludeProductIds.length) {
      where.push(`p.normalized_id NOT IN (${placeholders(filters.excludeProductIds.length)})`);
      params.push(...filters.excludeProductIds);
    }
    if (filters.codes.length) {
      const codeClauses = filters.codes.map(() => (
        '(p.normalized_id = ? OR EXISTS (SELECT 1 FROM variants vc WHERE vc.product_id = p.id AND (vc.normalized_id = ? OR vc.normalized_sku = ? OR vc.normalized_barcode = ?)))'
      ));
      where.push(`(${codeClauses.join(' OR ')})`);
      for (const code of filters.codes) params.push(code, code, code, code);
      scores.push('10000');
    }
    if (filters.brands.length) {
      where.push(`(${filters.brands.map(() => '(p.normalized_brand = ? OR p.normalized_name LIKE ?)').join(' OR ')})`);
      for (const brand of filters.brands) params.push(brand, `%${brand}%`);
      scores.push('400');
    }
    if (filters.excludeBrands.length) {
      where.push(`p.normalized_brand NOT IN (${placeholders(filters.excludeBrands.length)})`);
      params.push(...filters.excludeBrands);
      for (const brand of filters.excludeBrands) {
        where.push('p.normalized_name NOT LIKE ?');
        params.push(`%${brand}%`);
      }
    }
    if (filters.categories.length) {
      where.push(`(${filters.categories.map(() => '(p.normalized_type LIKE ? OR p.identity_text LIKE ?)').join(' OR ')})`);
      for (const category of filters.categories) params.push(`%${category}%`, `%${category}%`);
      scores.push('350');
    }
    for (const category of filters.excludeCategories) {
      where.push('p.normalized_type NOT LIKE ?');
      params.push(`%${category}%`);
    }
    if (filters.names.length) {
      where.push(`(${filters.names.map(() => '(p.normalized_name LIKE ? OR p.identity_text LIKE ?)').join(' OR ')})`);
      for (const name of filters.names) params.push(`%${name}%`, `%${name}%`);
      scores.push('500');
    }
    for (const group of filters.requirements) {
      const column = group.scope === 'identity' ? 'p.identity_text' : 'p.search_text';
      where.push(`(${group.terms.map(() => `${column} LIKE ?`).join(' OR ')})`);
      params.push(...group.terms.map((term) => `%${term}%`));
      scores.push('250');
    }
    for (const term of filters.excludeTerms) {
      where.push('p.search_text NOT LIKE ?');
      params.push(`%${term}%`);
    }

    const variantWhere = ['v.product_id = p.id'];
    if (filters.inStockOnly) variantWhere.push('v.in_stock = 1');
    if (filters.colors.length) {
      variantWhere.push(`(${filters.colors.map(() => 'v.normalized_color LIKE ?').join(' OR ')})`);
      params.push(...filters.colors.map((color) => `%${color}%`));
      scores.push('300');
    }
    if (filters.sizes.length) {
      variantWhere.push(`v.normalized_size IN (${placeholders(filters.sizes.length)})`);
      params.push(...filters.sizes);
      scores.push('300');
    }
    for (const color of filters.excludeColors) {
      variantWhere.push('v.normalized_color NOT LIKE ?');
      params.push(`%${color}%`);
    }
    if (filters.excludeSizes.length) {
      variantWhere.push(`v.normalized_size NOT IN (${placeholders(filters.excludeSizes.length)})`);
      params.push(...filters.excludeSizes);
    }
    if (filters.minPrice !== null) {
      variantWhere.push('v.price >= ?');
      params.push(filters.minPrice);
      scores.push('150');
    }
    if (filters.maxPrice !== null) {
      variantWhere.push('v.price <= ?');
      params.push(filters.maxPrice);
      scores.push('150');
    }
    const hasVariantConstraint = filters.inStockOnly || filters.colors.length || filters.sizes.length
      || filters.excludeColors.length || filters.excludeSizes.length
      || filters.minPrice !== null || filters.maxPrice !== null;
    if (hasVariantConstraint) where.push(`EXISTS (SELECT 1 FROM variants v WHERE ${variantWhere.join(' AND ')})`);

    for (const preference of filters.preferences) {
      const clauses = preference.terms.map(() => 'p.search_text LIKE ?');
      scores.push(`CASE WHEN (${clauses.join(' OR ')}) THEN 80 ELSE 0 END`);
      scoreParams.push(...preference.terms.map((term) => `%${term}%`));
    }

    const stopWords = new Set(['tim', 'mua', 'cho', 'xem', 'san', 'pham', 'co', 'khong', 'cua', 'toi', 'minh', 'shop']);
    const queryTokens = unique(filters.query.split(' '))
      .filter((token) => token.length > 1 && !/^\d+(?:\.\d+)?$/.test(token) && !stopWords.has(token))
      .slice(0, 10);
    const hasStructured = Boolean(
      filters.productIds.length || filters.codes.length || filters.names.length || filters.brands.length
      || filters.categories.length || filters.colors.length || filters.sizes.length || filters.requirements.length
      || filters.excludeBrands.length || filters.excludeCategories.length
      || filters.excludeColors.length || filters.excludeSizes.length
      || filters.excludeTerms.length || filters.minPrice !== null || filters.maxPrice !== null
    );
    if (queryTokens.length) {
      const tokenClauses = queryTokens.map(() => '(p.normalized_name LIKE ? OR p.search_text LIKE ?)');
      if (!hasStructured) {
        where.push(`(${tokenClauses.join(' OR ')})`);
        for (const token of queryTokens) params.push(`%${token}%`, `%${token}%`);
      }
      for (const token of queryTokens) {
        scores.push('CASE WHEN p.normalized_name LIKE ? THEN 24 WHEN p.search_text LIKE ? THEN 6 ELSE 0 END');
        scoreParams.push(`%${token}%`, `%${token}%`);
      }
    }

    const scoreSql = scores.length ? scores.join(' + ') : '0';
    const sql = `
      SELECT p.id AS product_id, (${scoreSql}) AS score
      FROM products p
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY score DESC, p.in_stock DESC, p.price_min ASC, p.id ASC
      LIMIT ?
    `;
    return this.db.prepare(sql).all(...scoreParams, ...params, limit).map((row) => ({
      productId: String(row.product_id),
      score: Number(row.score || 0)
    }));
  }

  status() {
    return {
      engine: 'sqlite',
      filename: this.filename,
      productCount: this.productCount,
      variantCount: this.variantCount,
      lastRebuiltAt: this.lastRebuiltAt
    };
  }

  close() {
    this.db.close();
  }
}

module.exports = { CatalogDatabase, normalizeSqlText: normalize };
