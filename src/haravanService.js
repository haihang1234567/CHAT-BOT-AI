const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGES = 500;
const INVENTORY_BATCH_SIZE = 50;

function clean(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function numberValue(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function stripHtml(value) {
  return clean(value)
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

function chunk(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function normalizeOptionName(value) {
  return clean(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isColorOption(name) {
  const normalized = normalizeOptionName(name);
  return ['mau', 'mau sac', 'color', 'colour'].includes(normalized);
}

function isSizeOption(name) {
  const normalized = normalizeOptionName(name);
  return ['size', 'kich thuoc', 'kich co'].includes(normalized);
}

function imageForVariant(images, variant) {
  const variantId = String(variant.id);
  const byImageId = images.find((image) => String(image.id) === String(variant.image_id));
  if (byImageId?.src) return clean(byImageId.src);
  const byVariantId = images.find((image) => (
    Array.isArray(image.variant_ids)
    && image.variant_ids.some((id) => String(id) === variantId)
  ));
  return clean(byVariantId?.src);
}

class HaravanService {
  constructor(config, productService, fetchImpl = global.fetch) {
    this.config = config;
    this.productService = productService;
    this.fetchImpl = fetchImpl;
    this.syncing = false;
    this.lastSyncAt = null;
    this.lastError = '';
    this.lastStats = null;
    this.timer = null;
  }

  isConfigured() {
    return Boolean(this.config?.token && this.config?.baseUrl);
  }

  status() {
    return {
      enabled: this.isConfigured(),
      syncing: this.syncing,
      lastSyncAt: this.lastSyncAt,
      lastError: this.lastError,
      stats: this.lastStats
    };
  }

  endpoint(pathname, params = {}) {
    const base = `${this.config.baseUrl.replace(/\/$/, '')}/`;
    const url = new URL(String(pathname || '').replace(/^\/+/, ''), base);
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, String(value));
    }
    return url;
  }

  async request(pathname, params = {}, attempt = 0) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const response = await this.fetchImpl(this.endpoint(pathname, params), {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.token}`
        },
        signal: controller.signal
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        if (attempt < 2 && (response.status === 429 || response.status >= 500)) {
          await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
          return this.request(pathname, params, attempt + 1);
        }
        const detail = body.slice(0, 300).replace(/\s+/g, ' ');
        throw new Error(`Haravan ${response.status}${detail ? `: ${detail}` : ''}`);
      }
      return response.json();
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new Error(`Haravan không phản hồi sau ${this.config.timeoutMs}ms.`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async fetchAll(pathname, responseKey, params = {}, pageSize = this.config.pageSize) {
    const items = [];
    const safePageSize = Math.max(1, Math.min(250, Number(pageSize || DEFAULT_PAGE_SIZE)));
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const data = await this.request(pathname, { ...params, limit: safePageSize, page });
      const pageItems = Array.isArray(data?.[responseKey]) ? data[responseKey] : [];
      items.push(...pageItems);
      if (pageItems.length < safePageSize) break;
      if (page === MAX_PAGES) throw new Error(`Haravan trả quá ${MAX_PAGES} trang cho ${pathname}.`);
    }
    return items;
  }

  async fetchCollections() {
    const params = this.config.includeUnpublished ? { published_status: 'any' } : { published_status: 'published' };
    const [customCollections, smartCollections, collects] = await Promise.all([
      this.fetchAll('/custom_collections.json', 'custom_collections', params),
      this.fetchAll('/smart_collections.json', 'smart_collections', params),
      this.fetchAll('/collects.json', 'collects', {}, 250)
    ]);

    const collectionById = new Map();
    for (const collection of [...customCollections, ...smartCollections]) {
      collectionById.set(String(collection.id), {
        id: String(collection.id),
        title: clean(collection.title),
        handle: clean(collection.handle)
      });
    }

    const collectionIdsByProductId = new Map();
    for (const collect of collects) {
      const productId = String(collect.product_id);
      const collectionId = String(collect.collection_id);
      if (!collectionById.has(collectionId)) continue;
      if (!collectionIdsByProductId.has(productId)) collectionIdsByProductId.set(productId, []);
      collectionIdsByProductId.get(productId).push(collectionId);
    }

    return {
      collectionById,
      collectionIdsByProductId,
      count: collectionById.size
    };
  }

  async fetchLocationIds() {
    if (this.config.locationIds.length) return this.config.locationIds;
    const data = await this.request('/locations.json');
    return (Array.isArray(data?.locations) ? data.locations : [])
      .filter((location) => !location.is_unavailable_quantity)
      .map((location) => String(location.id))
      .filter(Boolean);
  }

  async fetchInventory(products) {
    if (!this.config.useLocationInventory) return new Map();
    const locationIds = await this.fetchLocationIds();
    const variantIds = unique(products.flatMap((product) => (
      Array.isArray(product.variants) ? product.variants.map((variant) => String(variant.id)) : []
    )));
    if (!locationIds.length || !variantIds.length) return new Map();

    const quantityByVariantId = new Map();
    for (const locationBatch of chunk(locationIds, INVENTORY_BATCH_SIZE)) {
      for (const variantBatch of chunk(variantIds, INVENTORY_BATCH_SIZE)) {
        const data = await this.request('/inventory_locations.json', {
          location_ids: locationBatch.join(','),
          variant_ids: variantBatch.join(','),
          limit: 250
        });
        const balances = Array.isArray(data?.inventory_locations) ? data.inventory_locations : [];
        for (const balance of balances) {
          const variantId = String(balance.variant_id);
          const current = quantityByVariantId.get(variantId) || 0;
          quantityByVariantId.set(variantId, current + numberValue(balance.qty_available));
        }
      }
    }
    return quantityByVariantId;
  }

  optionValues(product, variant) {
    const options = Array.isArray(product.options) ? product.options : [];
    let color = '';
    let size = '';
    for (let position = 1; position <= 3; position += 1) {
      const option = options.find((item) => Number(item.position) === position) || options[position - 1];
      const value = clean(variant[`option${position}`]);
      if (!option || !value) continue;
      if (isColorOption(option.name)) color = value;
      if (isSizeOption(option.name)) size = value;
    }
    return { color, size };
  }

  mapProducts(rawProducts, collections, inventoryByVariantId) {
    return rawProducts
      .filter((product) => (
        this.config.includeUnpublished
        || (product.published_at && !product.only_hide_from_list)
      ))
      .map((product) => {
        const images = (Array.isArray(product.images) ? product.images : [])
          .slice()
          .sort((a, b) => numberValue(a.position) - numberValue(b.position));
        const collectionIds = unique(collections.collectionIdsByProductId.get(String(product.id)) || []);
        const collectionItems = collectionIds
          .map((id) => collections.collectionById.get(id))
          .filter(Boolean);
        const variants = (Array.isArray(product.variants) ? product.variants : []).map((variant) => {
          const { color, size } = this.optionValues(product, variant);
          const aggregateQuantity = numberValue(
            variant.inventory_advance?.qty_available ?? variant.inventory_quantity
          );
          const quantity = inventoryByVariantId.has(String(variant.id))
            ? inventoryByVariantId.get(String(variant.id))
            : aggregateQuantity;
          return {
            id: String(variant.id),
            sku: clean(variant.sku),
            barcode: clean(variant.barcode),
            color,
            size,
            quantity,
            inStock: quantity > 0,
            price: numberValue(variant.price),
            compareAtPrice: numberValue(variant.compare_at_price),
            image: imageForVariant(images, variant)
          };
        });

        return {
          id: String(product.id),
          name: clean(product.title) || `Sản phẩm ${product.id}`,
          slug: clean(product.handle),
          url: product.handle
            ? `${this.productService.shopDomain}/products/${String(product.handle).replace(/^\/+/, '')}`
            : this.productService.shopDomain,
          brand: clean(product.vendor),
          type: clean(product.product_type),
          tags: clean(product.tags),
          description: stripHtml(product.body_plain || product.body_html),
          excerpt: stripHtml(product.body_plain),
          images: unique(images.map((image) => clean(image.src))),
          collections: collectionItems.map((item) => item.title).filter(Boolean),
          collectionHandles: collectionItems.map((item) => item.handle).filter(Boolean),
          variants
        };
      });
  }

  async sync() {
    if (!this.isConfigured()) throw new Error('Chưa cấu hình HARAVAN_ACCESS_TOKEN.');
    if (this.syncing) return this.lastStats;
    this.syncing = true;
    try {
      const [rawProducts, collections] = await Promise.all([
        this.fetchAll('/products.json', 'products'),
        this.fetchCollections()
      ]);

      let inventoryByVariantId = new Map();
      let inventoryWarning = '';
      try {
        inventoryByVariantId = await this.fetchInventory(rawProducts);
      } catch (error) {
        inventoryWarning = error.message;
        console.warn(`Không lấy được tồn kho theo địa điểm; dùng tồn kho tổng trên biến thể: ${error.message}`);
      }

      const mappedProducts = this.mapProducts(rawProducts, collections, inventoryByVariantId);
      if (!mappedProducts.length) throw new Error('Haravan không trả sản phẩm đang xuất bản nào.');
      this.productService.replaceProducts(mappedProducts, 'haravan');

      const variantCount = mappedProducts.reduce((sum, product) => sum + product.variants.length, 0);
      this.lastSyncAt = new Date().toISOString();
      this.lastError = inventoryWarning;
      this.lastStats = {
        products: mappedProducts.length,
        variants: variantCount,
        collections: collections.count,
        locationInventory: inventoryByVariantId.size > 0
      };
      console.log(
        `Đồng bộ Haravan: ${mappedProducts.length} sản phẩm / ${variantCount} biến thể / ${collections.count} nhóm.`
      );
      return this.lastStats;
    } catch (error) {
      this.lastError = error.message;
      throw error;
    } finally {
      this.syncing = false;
    }
  }

  startAutoSync(onError = () => {}, onSuccess = () => {}) {
    const intervalMs = Math.max(60_000, Number(this.config.syncIntervalMs || 600_000));
    this.stopAutoSync();
    this.timer = setInterval(() => {
      this.sync().then(onSuccess).catch(onError);
    }, intervalMs);
    this.timer.unref();
  }

  stopAutoSync() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = HaravanService;
