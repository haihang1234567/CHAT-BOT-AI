const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function clean(value, maxLength = 1200) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function unique(values) {
  return [...new Set((values || []).map((value) => clean(value, 120)).filter(Boolean))];
}

function buildProductEmbeddingText(product = {}) {
  const colors = unique(
    product.colors?.length
      ? product.colors
      : (product.variants || []).map((variant) => variant.color)
  );
  const sizes = unique(
    product.sizes?.length
      ? product.sizes
      : (product.variants || []).map((variant) => variant.size)
  );
  const attributes = [
    colors.length ? `Màu: ${colors.join(', ')}` : '',
    sizes.length ? `Size: ${sizes.join(', ')}` : ''
  ].filter(Boolean);

  return [
    clean(product.name, 220),
    clean(product.type, 120),
    clean(product.brand, 100),
    clean(product.tags, 220),
    unique(product.collections).join(', '),
    clean(product.excerpt, 520),
    ...attributes
  ].filter(Boolean).join(' | ').slice(0, 1200);
}

function cosineSimilarity(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length || !left.length) {
    return -1;
  }
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = Number(left[index]);
    const b = Number(right[index]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return -1;
    dot += a * b;
    leftMagnitude += a * a;
    rightMagnitude += b * b;
  }
  if (!leftMagnitude || !rightMagnitude) return -1;
  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}

function contentHash(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex');
}

function chunk(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

class EmbeddingService {
  constructor(config = {}, fetchImpl = global.fetch) {
    this.config = config;
    this.fetch = fetchImpl;
    this.entries = new Map();
    this.meta = {};
    this.queryCache = new Map();
    this.lastError = '';
    this.loadIndex();
  }

  isConfigured() {
    return Boolean(
      this.config.enabled
      && this.config.apiKey
      && this.config.endpoint
      && this.config.model
      && this.fetch
    );
  }

  status() {
    return {
      enabled: Boolean(this.config.enabled),
      configured: this.isConfigured(),
      model: this.config.model,
      outputDimension: this.config.outputDimension,
      vectorCount: this.entries.size,
      generatedAt: this.meta.generatedAt || null,
      lastError: this.lastError
    };
  }

  normalizeEntry(value) {
    if (Array.isArray(value)) return { hash: '', vector: value.map(Number) };
    if (!value || !Array.isArray(value.vector)) return null;
    return {
      hash: clean(value.hash, 80),
      vector: value.vector.map(Number)
    };
  }

  loadIndex() {
    const filePath = this.config.indexPath;
    if (!filePath || !fs.existsSync(filePath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const records = parsed?.products && typeof parsed.products === 'object'
        ? parsed.products
        : parsed;
      this.meta = parsed?._meta && typeof parsed._meta === 'object' ? parsed._meta : {};
      this.entries = new Map(
        Object.entries(records || {})
          .filter(([productId]) => productId !== '_meta')
          .map(([productId, value]) => [String(productId), this.normalizeEntry(value)])
          .filter(([, value]) => value?.vector?.length)
      );
    } catch (error) {
      this.lastError = `Không đọc được embeddings: ${error.message}`;
      console.warn(`[EMBEDDINGS] ${this.lastError}`);
    }
  }

  getVector(productId) {
    return this.entries.get(String(productId))?.vector || null;
  }

  async embedTexts(texts, inputType = 'document') {
    if (!this.isConfigured()) throw new Error('Chưa cấu hình Voyage AI embedding.');
    const input = (Array.isArray(texts) ? texts : [texts]).map((text) => clean(text, 32000));
    if (!input.length || input.some((text) => !text)) throw new Error('Nội dung embedding đang trống.');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const body = {
        input,
        model: this.config.model,
        input_type: inputType,
        truncation: true
      };
      if (this.config.outputDimension) body.output_dimension = this.config.outputDimension;
      const response = await this.fetch(this.config.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      const raw = await response.text();
      let data;
      try { data = JSON.parse(raw); } catch (_) { data = { raw }; }
      if (!response.ok) {
        const detail = data?.detail || data?.error?.message || data?.message || raw.slice(0, 300);
        throw new Error(`Voyage embeddings ${response.status}: ${detail}`);
      }
      const ordered = (Array.isArray(data?.data) ? data.data : [])
        .slice()
        .sort((left, right) => Number(left.index || 0) - Number(right.index || 0))
        .map((item) => item.embedding);
      if (ordered.length !== input.length || ordered.some((vector) => !Array.isArray(vector))) {
        throw new Error('Voyage AI trả về số lượng vector không hợp lệ.');
      }
      this.lastError = '';
      return ordered;
    } catch (error) {
      this.lastError = error.name === 'AbortError'
        ? 'Voyage AI embedding quá thời gian chờ.'
        : error.message;
      throw new Error(this.lastError);
    } finally {
      clearTimeout(timer);
    }
  }

  async embedText(text, inputType = 'query') {
    const normalized = clean(text, 32000);
    const cacheKey = `${this.config.model}:${this.config.outputDimension}:${inputType}:${normalized}`;
    const cached = this.queryCache.get(cacheKey);
    if (cached && Date.now() - cached.createdAt <= this.config.queryCacheTtlMs) {
      return cached.vector;
    }
    const [vector] = await this.embedTexts([normalized], inputType);
    this.queryCache.set(cacheKey, { vector, createdAt: Date.now() });
    if (this.queryCache.size > 500) this.queryCache.delete(this.queryCache.keys().next().value);
    return vector;
  }

  serializeIndex() {
    return {
      _meta: {
        version: 1,
        provider: 'voyage',
        model: this.config.model,
        outputDimension: this.config.outputDimension,
        generatedAt: new Date().toISOString()
      },
      products: Object.fromEntries(
        [...this.entries.entries()].map(([productId, entry]) => [productId, entry])
      )
    };
  }

  saveIndex() {
    const filePath = this.config.indexPath;
    if (!filePath) throw new Error('Chưa cấu hình đường dẫn file embeddings.');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(this.serializeIndex())}\n`, 'utf8');
    fs.renameSync(tempPath, filePath);
    this.meta = this.serializeIndex()._meta;
  }

  async syncProducts(products = [], options = {}) {
    if (!this.isConfigured()) return { built: 0, reused: 0, total: this.entries.size, skipped: true };
    const documents = (Array.isArray(products) ? products : [])
      .filter((product) => product?.id)
      .map((product) => {
        const text = buildProductEmbeddingText(product);
        return { id: String(product.id), text, hash: contentHash(text) };
      })
      .filter((item) => item.text);
    const currentIds = new Set(documents.map((item) => item.id));
    for (const productId of this.entries.keys()) {
      if (!currentIds.has(productId)) this.entries.delete(productId);
    }

    const force = Boolean(options.force);
    const sameModel = this.meta.model === this.config.model
      && Number(this.meta.outputDimension || 0) === Number(this.config.outputDimension || 0);
    const pending = documents.filter((item) => {
      const existing = this.entries.get(item.id);
      return force || !sameModel || !existing?.vector?.length || existing.hash !== item.hash;
    });
    const batchSize = Math.max(1, Math.min(1000, Number(this.config.batchSize || 64)));
    let built = 0;
    for (const batch of chunk(pending, batchSize)) {
      const vectors = await this.embedTexts(batch.map((item) => item.text), 'document');
      batch.forEach((item, index) => {
        this.entries.set(item.id, { hash: item.hash, vector: vectors[index] });
      });
      built += batch.length;
      if (typeof options.onProgress === 'function') {
        options.onProgress({ built, pending: pending.length, total: documents.length });
      }
    }
    this.saveIndex();
    return {
      built,
      reused: documents.length - pending.length,
      total: documents.length,
      skipped: false
    };
  }
}

module.exports = {
  EmbeddingService,
  buildProductEmbeddingText,
  cosineSimilarity,
  contentHash
};
