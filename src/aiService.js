const crypto = require('crypto');
const { normalizeText } = require('./productService');

const INTENTS = new Set([
  'greeting',
  'thanks',
  'search_by_code',
  'search_product',
  'product_detail',
  'product_recommendation',
  'compare_products',
  'create_order',
  'order_help',
  'admin_handoff',
  'general_question',
  'unknown'
]);

function cleanString(value, maxLength = 250) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function cleanList(value, maxItems = 8, maxLength = 100) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => cleanString(item, maxLength)).filter(Boolean))].slice(0, maxItems);
}

function cleanPrice(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(String(value).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : null;
}

function cleanNeedGroups(value, maxItems = 8, maxTerms = 8) {
  if (!Array.isArray(value)) return [];
  return value
    .map((group) => ({
      label: cleanString(group?.label, 120),
      terms: cleanList(group?.terms, maxTerms, 100),
      scope: group?.scope === 'identity' ? 'identity' : 'details'
    }))
    .filter((group) => group.terms.length)
    .slice(0, maxItems);
}

function uniqueStrings(values) {
  return [...new Set((values || []).map((value) => cleanString(value, 160)).filter(Boolean))];
}

class AiService {
  constructor(config, productService) {
    this.config = config;
    this.productService = productService;
    this.cache = new Map();
  }

  isConfigured() {
    return Boolean(
      this.config.baseUrl
      && this.config.token
      && this.config.routerModel
      && this.config.chatModel
    );
  }

  endpoint() {
    return `${this.config.baseUrl}${this.config.messagesPath.startsWith('/') ? '' : '/'}${this.config.messagesPath}`;
  }

  headers() {
    const headers = { 'Content-Type': 'application/json' };
    const mode = this.config.authMode;
    if (mode === 'x-api-key' || mode === 'both') headers['x-api-key'] = this.config.token;
    if (mode === 'bearer' || mode === 'authorization' || mode === 'both') {
      headers.Authorization = `Bearer ${this.config.token}`;
    }
    if (this.config.style === 'anthropic') {
      headers['anthropic-version'] = this.config.anthropicVersion;
    }
    return headers;
  }

  requestBody({ model, maxTokens, temperature, system, messages }) {
    const systemText = String(system || '').trim();

    if (this.config.style === 'openai') {
      const apiMessages = [];
      if (systemText) apiMessages.push({ role: 'system', content: systemText });
      apiMessages.push(...messages);
      return {
        model,
        temperature,
        max_tokens: maxTokens,
        messages: apiMessages
      };
    }

    const body = {
      model,
      max_tokens: maxTokens,
      temperature,
      messages
    };
    if (systemText) body.system = systemText;
    return body;
  }

  extractText(data) {
    if (Array.isArray(data?.content)) {
      return data.content
        .filter((block) => block?.type === 'text' || typeof block?.text === 'string')
        .map((block) => block.text || '')
        .join('\n')
        .trim();
    }
    if (typeof data?.choices?.[0]?.message?.content === 'string') {
      return data.choices[0].message.content.trim();
    }
    if (typeof data?.output_text === 'string') return data.output_text.trim();
    return '';
  }

  parseJson(text) {
    const cleaned = String(text || '')
      .replace(/^```(?:json)?/i, '')
      .replace(/```$/i, '')
      .trim();

    try {
      return JSON.parse(cleaned);
    } catch (_) {
      const match = cleaned.match(/\{[\s\S]*\}/);
      if (!match) return null;
      try { return JSON.parse(match[0]); } catch (_) { return null; }
    }
  }

  async call({ model, maxTokens, temperature = 0.1, system, messages }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const response = await fetch(this.endpoint(), {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(this.requestBody({ model, maxTokens, temperature, system, messages })),
        signal: controller.signal
      });

      const raw = await response.text();
      let data;
      try { data = JSON.parse(raw); } catch (_) { data = { raw }; }

      if (!response.ok) {
        const detail = data?.error?.message || data?.message || raw.slice(0, 500);
        throw new Error(`API AI ${response.status}: ${detail}`);
      }

      const text = this.extractText(data);
      if (!text) throw new Error('API AI không trả về nội dung văn bản.');
      return text;
    } finally {
      clearTimeout(timer);
    }
  }

  compactHistory(history = [], options = {}) {
    const limit = Math.max(0, Number(options.limit || this.config.historyMessages || 4));
    const maxChars = Math.max(80, Number(options.maxChars || this.config.historyChars || 350));
    return history
      .filter((item) => ['user', 'assistant', 'admin'].includes(item.role) && item.text)
      .slice(-limit)
      .map((item) => ({
        role: item.role === 'user' ? 'user' : 'assistant',
        text: cleanString(item.text, maxChars),
        productIds: Array.isArray(item.contextProductIds)
          ? item.contextProductIds.map(String).slice(0, 5)
          : Array.isArray(item.productIds)
            ? item.productIds.map(String).slice(0, 5)
            : []
      }));
  }

  cacheKey(prefix, payload) {
    return `${prefix}:${crypto.createHash('sha1').update(JSON.stringify(payload)).digest('hex')}`;
  }

  readCache(key) {
    const item = this.cache.get(key);
    if (!item) return null;
    if (Date.now() - item.createdAt > this.config.cacheTtlMs) {
      this.cache.delete(key);
      return null;
    }
    return { ...item.value, cached: true };
  }

  writeCache(key, value) {
    this.cache.set(key, { createdAt: Date.now(), value });
    if (this.cache.size > 500) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
  }

  buildRouterSystemPrompt() {
    return [
      'Bạn là AI định tuyến câu hỏi cho chatbot bán hàng Green Holding Sport.',
      'Nhiệm vụ duy nhất: hiểu ý khách và tạo KẾ HOẠCH TRUY VẤN DỮ LIỆU dưới dạng JSON.',
      'Bạn không có quyền truy cập database, không viết SQL, không tự trả lời giá/tồn kho/màu/size.',
      'Backend sẽ đọc các bộ lọc JSON và tự truy vấn CSV/database an toàn.',
      'Giá phải đổi thành số VND nguyên, ví dụ 2 triệu = 2000000.',
      'Khi khách nói “mẫu này”, “mẫu trên”, dùng productIds trong HISTORY nếu có.',
      'Luôn phân tích đủ: bộ môn, môi trường/mặt sân, trình độ, đặc điểm cơ thể hoặc form chân, ngân sách, size, màu và mục đích sử dụng.',
      'requirements là điều kiện bắt buộc. Mỗi object là một nhóm OR: sản phẩm chỉ cần khớp một terms trong nhóm.',
      'preferences là điều kiện ưu tiên để xếp hạng, không bắt buộc. excludeTerms là từ nhận diện sản phẩm phải loại bỏ.',
      'Ví dụ sân bóng 5/7 hoặc cỏ nhân tạo: requirements có nhóm TF/AS/cỏ nhân tạo/đinh dăm và excludeTerms có FG, SG.',
      'Ví dụ sân 11 cỏ tự nhiên: requirements có nhóm FG/SG/cỏ tự nhiên và loại TF/AS/IC.',
      'Ví dụ chạy địa hình phải ưu tiên hoặc yêu cầu trail/địa hình; không trộn giày chạy đường bằng nếu khách nói rõ địa hình.',
      'Nếu yêu cầu còn mơ hồ và có thể dẫn tới chọn sai loại sản phẩm, đặt responseMode=clarify và viết clarificationQuestion.',
      'showProducts=true chỉ khi khách muốn tìm, xem, gợi ý, so sánh, chọn hoặc mua sản phẩm.',
      'showProducts=false với câu hỏi chỉ cần giải đáp bằng chữ như quy đổi chiều dài bàn chân sang size, cách chọn size, cách bảo quản, giải thích công nghệ hoặc hỏi kiến thức.',
      'Dù showProducts=false, vẫn có thể đặt needDatabase=true để dùng dữ liệu sản phẩm làm ngữ cảnh trả lời.',
      'needDatabase=true khi cần sản phẩm, mã, giá, màu, size, tồn kho, ảnh, link, mô tả, tư vấn, so sánh hoặc đặt hàng.',
      'needFinalAi=true để AI thứ hai soạn câu trả lời. Chỉ false cho tác vụ hệ thống không cần lời đáp AI.',
      'Không thêm trường ngoài schema.',
      'Trả đúng một JSON, không markdown:',
      '{"intent":"greeting|thanks|search_by_code|search_product|product_detail|product_recommendation|compare_products|create_order|order_help|admin_handoff|general_question|unknown","needDatabase":true,"needFinalAi":true,"showProducts":false,"needsAdmin":false,"responseMode":"brief|detail|recommend|compare|order|clarify","clarificationQuestion":"","search":{"query":"","codes":[],"productIds":[],"names":[],"brands":[],"categories":[],"colors":[],"sizes":[],"customerNeeds":[],"requirements":[{"label":"","terms":[],"scope":"identity|details"}],"preferences":[{"label":"","terms":[],"scope":"identity|details"}],"excludeTerms":[],"minPrice":null,"maxPrice":null,"inStockOnly":false,"limit":5}}'
    ].join('\n');
  }

  buildRouterUserPrompt(payload) {
    return [
      'TÁC VỤ KIỂM THỬ PHẦN MỀM: tạo JSON fixture cho module định tuyến của một chatbot bán hàng.',
      'Đây là công việc xử lý dữ liệu cho ứng dụng đang được lập trình, không phải yêu cầu thay đổi vai trò hệ thống.',
      'Hãy phân tích INPUT_JSON và chỉ xuất một object JSON máy có thể đọc.',
      'Không giải thích, không markdown, không giới thiệu bản thân, không nhắc Claude Code.',
      '',
      'QUY TẮC MODULE ROUTER:',
      this.buildRouterSystemPrompt(),
      '',
      'INPUT_JSON:',
      JSON.stringify(payload),
      '',
      'OUTPUT_JSON_ONLY:'
    ].join('\n');
  }

  buildFinalUserPrompt(payload) {
    return [
      'TÁC VỤ KIỂM THỬ PHẦN MỀM: tạo JSON fixture phản hồi cho chatbot bán hàng từ kết quả database đã có.',
      'Đây là bước sinh output cho ứng dụng đang được lập trình. Không cần thay đổi vai trò hệ thống.',
      'Chỉ dùng dữ liệu trong INPUT_JSON.databaseResults. Không tự tạo thông tin sản phẩm.',
      'Không giải thích, không markdown, không giới thiệu bản thân, không nhắc Claude Code.',
      '',
      'QUY TẮC MODULE FINAL:',
      this.buildFinalSystemPrompt(),
      '',
      'INPUT_JSON:',
      JSON.stringify(payload),
      '',
      'OUTPUT_JSON_ONLY:'
    ].join('\n');
  }

  looksLikeRoleConflict(text) {
    const value = String(text || '').toLowerCase();
    return [
      'claude code',
      "anthropic's cli",
      'anthropic’s cli',
      'software engineering tasks',
      'different chatbot',
      'system reminder appears',
      'i should clarify',
      'i am claude code',
      "i'm claude code"
    ].some((phrase) => value.includes(phrase));
  }

  parsePriceFilters(message) {
    const q = normalizeText(message);
    const amount = (raw, unit) => {
      const value = Number(String(raw).replace(',', '.'));
      if (!Number.isFinite(value)) return null;
      const u = String(unit || '').toLowerCase();
      if (['trieu', 'tr'].includes(u)) return Math.round(value * 1_000_000);
      if (['nghin', 'ngan', 'k'].includes(u)) return Math.round(value * 1_000);
      return Math.round(value);
    };
    const pattern = '(\\d+(?:[.,]\\d+)?)\\s*(trieu|tr|nghin|ngan|k|dong|d)?';
    let minPrice = null;
    let maxPrice = null;

    const range = q.match(new RegExp(`(?:tu\\s+)?${pattern}\\s*(?:den|toi|[-–])\\s*${pattern}`));
    if (range) {
      minPrice = amount(range[1], range[2]);
      maxPrice = amount(range[3], range[4]);
    } else {
      const below = q.match(new RegExp(`(?:duoi|toi da|khong qua)\\s*${pattern}`));
      const above = q.match(new RegExp(`(?:tren|toi thieu|tu)\\s*${pattern}`));
      const around = q.match(new RegExp(`(?:khoang|tam)\\s*${pattern}`));
      if (below) maxPrice = amount(below[1], below[2]);
      if (above) minPrice = amount(above[1], above[2]);
      if (around) {
        const center = amount(around[1], around[2]);
        if (center !== null) {
          minPrice = Math.max(0, Math.round(center * 0.75));
          maxPrice = Math.round(center * 1.25);
        }
      }
    }
    return { minPrice, maxPrice };
  }

  codeShowProducts(message) {
    const q = normalizeText(message);
    const textOnly = [
      /\b(chieu dai ban chan|do dai ban chan|ban chan .{0,20}\d+(?:\.\d+)?\s*cm)\b/,
      /\b(\d+(?:\.\d+)?\s*cm .{0,30}(size|co nao|doi nao)|size nao|chon size|quy doi size)\b/,
      /\b(cach bao quan|cach ve sinh|giat giay|la gi|tai sao|khac nhau giua|huong dan su dung)\b/
    ].some((pattern) => pattern.test(q));
    if (textOnly) return false;

    const explicitlyWantsProducts = [
      /\b(tim|goi y|cho xem|xem cac mau|co mau nao|co doi nao|co san pham nao)\b/,
      /\b(mua|chon giup|them vao don|dat hang)\b/,
      /\b(so sanh) .{0,50}\b(mau|doi|san pham)\b/
    ].some((pattern) => pattern.test(q));
    if (explicitlyWantsProducts) return true;
    return null;
  }

  codeSearchRules(message) {
    const q = normalizeText(message);
    const categoryRules = [
      ['giay bong chuyen', /\b(giay bong chuyen|bong chuyen)\b/],
      ['bong da', /\b(giay bong da|giay da bong|bong da|san co nhan tao|futsal)\b/],
      ['da bong', /\b(giay bong da|giay da bong|bong da|san co nhan tao|futsal)\b/],
      ['giay chay bo', /\b(giay chay bo|giay chay|chay bo|chay dia hinh|running|trail running)\b/],
      ['giay cau long', /\b(giay cau long)\b/],
      ['vot cau long', /\b(vot cau long)\b/],
      ['vot pickleball', /\b(vot pickleball|pickleball)\b/],
      ['giay tennis', /\b(giay tennis|tennis)\b/],
      ['giay bong ro', /\b(giay bong ro|bong ro)\b/],
      ['ao', /\b(ao|polo|tee|tank top|jacket)\b/],
      ['quan', /\b(quan|short)\b/],
      ['balo', /\b(balo|ba lo)\b/],
      ['bong', /\b(bong thi dau|qua bong)\b/]
    ];
    const categories = categoryRules
      .filter(([, pattern]) => pattern.test(q))
      .map(([name]) => name)
      .slice(0, 8);
    const brands = ['mizuno', 'jogarbola', 'promax', 'mitre', 'joma', 'zocker']
      .filter((brand) => new RegExp(`(?:^|\\s)${brand}(?:$|\\s)`).test(q));
    const colorDictionary = [
      'trang', 'den', 'do', 'xanh', 'vang', 'hong', 'tim', 'cam', 'xam',
      'nau', 'xanh duong', 'xanh la', 'xanh navy', 'trang xanh', 'den trang'
    ];
    const colorContext = q.match(/\b(?:mau|color)\b([\s\S]{0,80})/);
    const colorText = colorContext ? colorContext[1] : '';
    const colors = colorDictionary.filter((color) => {
      if (!colorText) return false;
      const escaped = color.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(?:^|\\s)${escaped}(?:$|\\s)`).test(colorText);
    });
    if (colorText && /(?:^|\s)(?:be|beige)(?:$|\s)/.test(colorText)) colors.push('be');

    const sizes = [];
    for (const match of String(message || '').matchAll(/(?:size|sz|kích thước|kich thuoc)\s*[:=-]?\s*([0-9]+(?:[.,][0-9]+)?)/gi)) {
      sizes.push(match[1].replace(',', '.'));
    }

    const requirements = [];
    const preferences = [];
    const excludeTerms = [];
    const customerNeeds = [];
    const isFootball = categories.includes('bong da') || categories.includes('da bong');
    const artificialFootball = isFootball
      && /\b(san (?:5|7)|san co nhan tao|co nhan tao|dinh dam|turf)\b/.test(q);
    const naturalFootball = isFootball
      && /\b(san 11|san co tu nhien|co tu nhien|firm ground)\b/.test(q);
    const indoorFootball = isFootball
      && /\b(futsal|san trong nha|indoor)\b/.test(q);

    if (artificialFootball) {
      requirements.push({
        label: 'Mặt sân bóng đá sân 5/7 hoặc cỏ nhân tạo',
        terms: ['tf', 'as', 'cỏ nhân tạo', 'đinh dăm', 'turf'],
        scope: 'identity'
      });
      excludeTerms.push('fg', 'sg');
      customerNeeds.push('Giày bóng đá phù hợp sân 5/7 hoặc cỏ nhân tạo');
    } else if (naturalFootball) {
      requirements.push({
        label: 'Mặt sân bóng đá sân 11 hoặc cỏ tự nhiên',
        terms: ['fg', 'sg', 'cỏ tự nhiên', 'firm ground'],
        scope: 'identity'
      });
      excludeTerms.push('tf', 'as', 'ic', 'in');
      customerNeeds.push('Giày bóng đá phù hợp sân 11 hoặc cỏ tự nhiên');
    } else if (indoorFootball) {
      requirements.push({
        label: 'Bóng đá trong nhà hoặc futsal',
        terms: ['ic', 'in', 'futsal', 'sân trong nhà'],
        scope: 'identity'
      });
      excludeTerms.push('fg', 'sg', 'tf', 'as');
      customerNeeds.push('Giày bóng đá trong nhà hoặc futsal');
    }

    if (categories.includes('giay chay bo') && /\b(trail|dia hinh|duong mon|leo nui)\b/.test(q)) {
      requirements.push({
        label: 'Chạy địa hình',
        terms: ['trail', 'địa hình', 'đường mòn', 'mujin', 'daichi'],
        scope: 'details'
      });
      customerNeeds.push('Giày chạy địa hình');
    }

    if (/\b(chan (?:hoi )?be|be ngang|form rong|wide fit|ban chan rong)\b/.test(q)) {
      preferences.push({
        label: 'Phù hợp chân bè hoặc bàn chân rộng',
        terms: ['wide fit', 'form rộng', 'chân bè', 'bè ngang', '2e', '3e', '4e'],
        scope: 'details'
      });
      customerNeeds.push('Ưu tiên form phù hợp chân bè');
    }

    const { minPrice, maxPrice } = this.parsePriceFilters(message);
    if (minPrice !== null) customerNeeds.push(`Giá từ ${minPrice} VND`);
    if (maxPrice !== null) customerNeeds.push(`Giá không vượt quá ${maxPrice} VND`);

    return {
      brands,
      categories,
      colors: uniqueStrings(colors),
      sizes: uniqueStrings(sizes),
      customerNeeds,
      requirements,
      preferences,
      excludeTerms: uniqueStrings(excludeTerms),
      minPrice,
      maxPrice,
      inStockOnly: /\b(con hang|co hang|san pham san co)\b/.test(q)
    };
  }

  mergeCodeRules(route, message) {
    const rules = this.codeSearchRules(message);
    const codeShowProducts = this.codeShowProducts(message);
    const search = route.search || {};
    const knownSurface = rules.requirements.some((group) => group.scope === 'identity');
    const surfaceTerms = new Set([
      'tf', 'as', 'fg', 'sg', 'ag', 'ic', 'in', 'turf',
      'co nhan tao', 'co tu nhien', 'dinh dam', 'firm ground', 'futsal', 'san trong nha'
    ]);
    const aiRequirements = (search.requirements || []).filter((group) => {
      if (!knownSurface) return true;
      return !(group.terms || []).some((term) => surfaceTerms.has(normalizeText(term)));
    });
    const aiExcludeTerms = (search.excludeTerms || []).filter((term) => {
      return !knownSurface || !surfaceTerms.has(normalizeText(term));
    });
    const beigeExplicit = /\b(?:mau|color)\s+(?:be|beige)\b|\bbeige\b/.test(normalizeText(message));
    const aiColors = (search.colors || []).filter((color) => normalizeText(color) !== 'be' || beigeExplicit);

    return {
      ...route,
      showProducts: codeShowProducts === null ? route.showProducts : codeShowProducts,
      search: {
        ...search,
        brands: uniqueStrings([...(rules.brands || []), ...(search.brands || [])]),
        categories: uniqueStrings([...(rules.categories || []), ...(search.categories || [])]),
        colors: uniqueStrings([...(rules.colors || []), ...aiColors]),
        sizes: uniqueStrings([...(rules.sizes || []), ...(search.sizes || [])]),
        customerNeeds: uniqueStrings([...(rules.customerNeeds || []), ...(search.customerNeeds || [])]),
        requirements: [...rules.requirements, ...aiRequirements],
        preferences: [...rules.preferences, ...(search.preferences || [])],
        excludeTerms: uniqueStrings([...rules.excludeTerms, ...aiExcludeTerms]),
        minPrice: rules.minPrice !== null ? rules.minPrice : search.minPrice,
        maxPrice: rules.maxPrice !== null ? rules.maxPrice : search.maxPrice,
        inStockOnly: rules.inStockOnly || Boolean(search.inStockOnly)
      }
    };
  }

  fallbackRoute(message, history = [], warning = '') {
    const q = normalizeText(message);
    const compactHistory = this.compactHistory(history, {
      limit: this.config.routerHistoryMessages,
      maxChars: this.config.routerHistoryChars
    });
    const historyIds = [...new Set(compactHistory.flatMap((item) => item.productIds || []))].slice(-5);
    const contextReference = /\b(mau nay|san pham nay|doi nay|cai nay|mau tren|san pham tren|doi tren)\b/.test(q);
    const codeTokens = String(message || '').match(/\b[A-Za-z0-9][A-Za-z0-9._/-]{4,}\b/g) || [];
    const codes = [...new Set(codeTokens.filter((token) => /[A-Za-z]/.test(token) && /\d/.test(token)))].slice(0, 10);
    const codeRules = this.codeSearchRules(message);

    let intent = 'search_product';
    let responseMode = 'brief';
    let needDatabase = true;
    let needsAdmin = false;

    if (/^(admin|\/admin|gap admin|gap nhan vien)$/.test(q)) {
      intent = 'admin_handoff';
      responseMode = 'brief';
      needDatabase = false;
      needsAdmin = true;
    } else if (/^(xin chao|chao|hello|hi|alo|shop oi|ad oi)[!. ]*$/.test(q)) {
      intent = 'greeting';
      responseMode = 'brief';
      needDatabase = false;
    } else if (/^(cam on|thank|thanks|ok cam on|duoc roi cam on)[!. ]*$/.test(q)) {
      intent = 'thanks';
      responseMode = 'brief';
      needDatabase = false;
    } else if (/\b(dat hang|mua|len don|chot don|them vao don|them gio hang)\b/.test(q)) {
      intent = 'create_order';
      responseMode = 'order';
    } else if (/\b(so sanh|khac nhau|mau nao tot hon)\b/.test(q)) {
      intent = 'compare_products';
      responseMode = 'compare';
    } else if (/\b(tu van|goi y|nen chon|phu hop|chon giup|tot hon|danh gia)\b/.test(q)) {
      intent = 'product_recommendation';
      responseMode = 'recommend';
    } else if (/\b(mo ta|chi tiet|cong nghe|chat lieu|tinh nang|mau gi|size nao|con hang|gia bao nhieu)\b/.test(q)) {
      intent = 'product_detail';
      responseMode = 'detail';
    } else if (codes.length) {
      intent = 'search_by_code';
      responseMode = 'detail';
    }

    const raw = {
      intent,
      needDatabase,
      needFinalAi: true,
      showProducts: this.codeShowProducts(message) ?? [
        'search_by_code', 'search_product', 'product_recommendation',
        'compare_products', 'create_order'
      ].includes(intent),
      needsAdmin,
      responseMode,
      clarificationQuestion: '',
      search: {
        query: String(message || ''),
        codes,
        productIds: contextReference ? historyIds : [],
        names: [],
        brands: codeRules.brands,
        categories: codeRules.categories,
        colors: codeRules.colors,
        sizes: codeRules.sizes,
        customerNeeds: codeRules.customerNeeds,
        requirements: codeRules.requirements,
        preferences: codeRules.preferences,
        excludeTerms: codeRules.excludeTerms,
        minPrice: codeRules.minPrice,
        maxPrice: codeRules.maxPrice,
        inStockOnly: codeRules.inStockOnly,
        limit: this.config.maxCandidates || 5
      }
    };
    return {
      ...this.normalizeRoute(raw, message),
      _source: 'code-router-fallback',
      _warning: cleanString(warning, 500)
    };
  }

  fallbackFinal(message, route, candidates = [], warning = '') {
    const productIds = candidates.slice(0, 5).map((item) => String(item.id));
    let reply;

    if (route?.showProducts === false) {
      const q = normalizeText(message);
      const footLength = q.match(/(\d+(?:\.\d+)?)\s*cm/);
      if (footLength && /\b(chieu dai ban chan|do dai ban chan|ban chan|size)\b/.test(q)) {
        reply = `Bàn chân dài ${footLength[1]} cm chưa thể chốt một size chung cho mọi mẫu vì mỗi dòng giày có bảng quy đổi khác nhau. Bạn cho mình biết đúng tên mẫu hoặc mã sản phẩm đang quan tâm, mình sẽ đối chiếu size phù hợp và không cần hiển thị lại danh sách ảnh.`;
      } else {
        reply = 'Mình hiểu đây là câu hỏi chỉ cần trả lời bằng thông tin, không cần hiển thị sản phẩm. Hiện AI đang tạm thời chưa kết nối nên mình chưa muốn suy đoán; bạn thử gửi lại sau ít phút hoặc gõ “admin” để được hỗ trợ chính xác.';
      }
      return {
        reply,
        productIds: [],
        needsAdmin: false,
        _source: 'code-final-fallback',
        _warning: cleanString(warning, 500)
      };
    }

    if (!candidates.length) {
      reply = 'Mình chưa tìm thấy sản phẩm phù hợp trong dữ liệu hiện tại. Bạn gửi thêm tên, mã sản phẩm, size, màu hoặc mức giá nhé. Cần hỗ trợ trực tiếp, bạn có thể gõ “admin”.';
    } else if (candidates.length === 1) {
      reply = `Mình đã tìm thấy “${candidates[0].name}”. Ảnh, giá, màu, size, tình trạng còn hàng và link chi tiết được hiển thị trong thẻ sản phẩm bên dưới.`;
    } else {
      const names = candidates.slice(0, 3).map((item) => `“${item.name}”`).join(', ');
      const action = route?.responseMode === 'compare'
        ? 'Bạn có thể đối chiếu giá, màu, size và tình trạng trên từng thẻ.'
        : 'Bạn xem các lựa chọn phù hợp ở thẻ bên dưới nhé.';
      reply = `Mình đã lọc được ${Math.min(candidates.length, 5)} sản phẩm, nổi bật gồm ${names}. ${action}`;
    }

    return {
      reply,
      productIds,
      needsAdmin: false,
      _source: 'code-final-fallback',
      _warning: cleanString(warning, 500)
    };
  }

  normalizeRoute(raw, message) {
    const intent = INTENTS.has(String(raw?.intent)) ? String(raw.intent) : 'unknown';
    const search = raw?.search && typeof raw.search === 'object' ? raw.search : {};
    const needDatabaseByIntent = [
      'search_by_code', 'search_product', 'product_detail',
      'product_recommendation', 'compare_products', 'create_order'
    ].includes(intent);

    const normalized = {
      intent,
      needDatabase: raw?.needDatabase === undefined ? needDatabaseByIntent : Boolean(raw.needDatabase),
      needFinalAi: this.config.alwaysFinal ? true : Boolean(raw?.needFinalAi),
      showProducts: typeof raw?.showProducts === 'boolean'
        ? raw.showProducts
        : ['search_by_code', 'search_product', 'product_recommendation', 'compare_products', 'create_order'].includes(intent),
      needsAdmin: Boolean(raw?.needsAdmin) || intent === 'admin_handoff',
      responseMode: ['brief', 'detail', 'recommend', 'compare', 'order', 'clarify'].includes(String(raw?.responseMode))
        ? String(raw.responseMode)
        : 'brief',
      clarificationQuestion: cleanString(raw?.clarificationQuestion, 240),
      search: {
        query: cleanString(search.query || message, 500),
        codes: cleanList(search.codes, 10, 100),
        productIds: cleanList(search.productIds, 10, 100),
        names: cleanList(search.names, 8, 160),
        brands: cleanList(search.brands, 8, 80),
        categories: cleanList(search.categories, 8, 100),
        colors: cleanList(search.colors, 8, 80),
        sizes: cleanList(search.sizes, 10, 40),
        customerNeeds: cleanList(search.customerNeeds, 12, 160),
        requirements: cleanNeedGroups(search.requirements, 8, 8),
        preferences: cleanNeedGroups(search.preferences, 8, 8),
        excludeTerms: cleanList(search.excludeTerms, 16, 100),
        minPrice: cleanPrice(search.minPrice),
        maxPrice: cleanPrice(search.maxPrice),
        inStockOnly: Boolean(search.inStockOnly),
        limit: Math.max(1, Math.min(10, Number(search.limit || this.config.maxCandidates || 5)))
      }
    };

    if (normalized.search.minPrice !== null && normalized.search.maxPrice !== null
      && normalized.search.minPrice > normalized.search.maxPrice) {
      [normalized.search.minPrice, normalized.search.maxPrice] = [
        normalized.search.maxPrice,
        normalized.search.minPrice
      ];
    }

    return normalized;
  }

  async route(message, history = []) {
    if (!this.isConfigured()) return null;

    const compactHistory = this.compactHistory(history, {
      limit: this.config.routerHistoryMessages,
      maxChars: this.config.routerHistoryChars
    });
    const payload = { message: cleanString(message, 1500), history: compactHistory };
    const key = this.cacheKey('router', payload);
    const cached = this.readCache(key);
    if (cached) return cached;

    const text = await this.call({
      model: this.config.routerModel,
      maxTokens: this.config.routerMaxTokens,
      temperature: 0,
      system: '',
      messages: [{ role: 'user', content: this.buildRouterUserPrompt(payload) }]
    });

    const parsed = this.parseJson(text);
    let result;
    if (!parsed) {
      const warning = `AI Router không trả JSON; đã dùng Router bằng code. Phản hồi AI: ${text.slice(0, 220)}`;
      console.warn(warning);
      result = this.fallbackRoute(message, history, warning);
    } else {
      result = {
        ...this.mergeCodeRules(this.normalizeRoute(parsed, message), message),
        _source: 'ai-router'
      };
    }
    this.writeCache(key, result);
    return result;
  }

  buildFinalSystemPrompt() {
    return [
      'Bạn là nhân viên tư vấn Green Holding Sport, trả lời tự nhiên như người thật.',
      'Đây là AI lần 2. AI lần 1 đã phân tích ý định; backend đã truy vấn database bằng code.',
      'Trước khi tư vấn, đối chiếu lại toàn bộ customerNeeds, requirements, preferences, excludeTerms và ngân sách trong ROUTE.',
      'Chỉ dùng dữ liệu trong DATABASE_RESULTS. Không bịa giá, giá gốc, khuyến mãi, tồn kho, màu, size, mã, ảnh, link, công nghệ hay chính sách.',
      'Không gọi một sản phẩm là phù hợp nếu tên, loại, mô tả hoặc biến thể mâu thuẫn với điều kiện bắt buộc của khách.',
      'Nếu không có sản phẩm đáp ứng đủ điều kiện bắt buộc, nói rõ chưa tìm thấy; productIds phải là mảng rỗng. Không chọn sản phẩm gần đúng chỉ để đủ số lượng.',
      'Nếu dữ liệu chưa đủ để xác minh một ưu tiên như form chân, độ êm hoặc trình độ sử dụng, nói rõ chưa thể xác nhận thay vì tự suy đoán.',
      'Nếu ROUTE.showProducts=false, chỉ trả lời trực tiếp câu hỏi; không liệt kê hàng loạt mẫu, không mời xem thẻ và nên để productIds=[] trừ khi cần giữ đúng một sản phẩm đang được hỏi làm ngữ cảnh.',
      'Tồn kho chỉ nói “Còn hàng” hoặc “Hết hàng”, không nói số lượng.',
      'Ảnh, giá, biến thể và nút xem chi tiết được giao diện dựng từ database; câu trả lời không cần chép lại toàn bộ dữ liệu.',
      'Nếu không có kết quả, nói rõ chưa tìm thấy và hỏi khách bổ sung tên/mã/size/màu/mức giá; có thể gợi ý gõ “admin”.',
      'Nếu có nhiều lựa chọn, nêu ngắn gọn lý do phù hợp và chọn tối đa 5 productIds có trong DATABASE_RESULTS.',
      'Không được trả productId không tồn tại trong DATABASE_RESULTS.',
      'Trả đúng JSON, không markdown: {"reply":"...","productIds":["..."],"needsAdmin":false}'
    ].join('\n');
  }

  finalCacheKey(message, route, candidates, history) {
    const compactHistory = this.compactHistory(history).slice(-2);
    return this.cacheKey('final', {
      message: cleanString(message, 1500),
      route,
      productIds: candidates.map((item) => item.id),
      history: compactHistory
    });
  }

  async answer(message, route, candidates = [], history = []) {
    if (!this.isConfigured()) return null;

    const limitedCandidates = candidates.slice(0, Math.max(1, this.config.maxCandidates || 5));
    const key = this.finalCacheKey(message, route, limitedCandidates, history);
    const cached = this.readCache(key);
    if (cached) return cached;

    const databaseResults = this.productService.compactForAi(limitedCandidates, message, {
      maxProducts: this.config.maxCandidates,
      maxVariants: this.config.maxVariants,
      descriptionChars: this.config.descriptionChars
    });
    const payload = {
      customerMessage: cleanString(message, 1500),
      route,
      recentHistory: this.compactHistory(history),
      databaseResults
    };

    const text = await this.call({
      model: this.config.chatModel,
      maxTokens: this.config.finalMaxTokens,
      temperature: 0.2,
      system: '',
      messages: [{ role: 'user', content: this.buildFinalUserPrompt(payload) }]
    });

    const parsed = this.parseJson(text);
    let result;
    if (!parsed?.reply) {
      if (this.looksLikeRoleConflict(text)) {
        const warning = `AI Final đang dùng persona Claude Code; đã dùng câu trả lời bằng code. Phản hồi AI: ${text.slice(0, 220)}`;
        console.warn(warning);
        result = this.fallbackFinal(message, route, limitedCandidates, warning);
      } else if (text) {
        result = {
          reply: cleanString(text, 3500),
          productIds: limitedCandidates.slice(0, 5).map((item) => item.id),
          needsAdmin: false,
          _source: 'ai-final-text'
        };
      } else {
        result = this.fallbackFinal(message, route, limitedCandidates, 'AI Final không trả nội dung.');
      }
    } else {
      const allowedIds = new Set(limitedCandidates.map((item) => String(item.id)));
      const productIds = Array.isArray(parsed.productIds)
        ? parsed.productIds.map(String).filter((id) => allowedIds.has(id)).slice(0, 5)
        : [];
      result = {
        reply: cleanString(parsed.reply, 3500),
        productIds: Array.isArray(parsed.productIds)
          ? productIds
          : limitedCandidates.slice(0, 5).map((item) => item.id),
        needsAdmin: Boolean(parsed.needsAdmin),
        _source: 'ai-final'
      };
    }

    this.writeCache(key, result);
    return result;
  }

  async testConnection() {
    if (!this.isConfigured()) {
      return {
        ok: false,
        message: 'Chưa điền token và model. Có thể dùng AI_MODEL chung hoặc AI_ROUTER_MODEL + AI_CHAT_MODEL.'
      };
    }

    const route = await this.route('Xin chào, hãy kiểm tra kết nối hai tầng.', []);
    const final = await this.answer(
      'Xin chào, hãy kiểm tra kết nối hai tầng.',
      { ...route, needDatabase: false },
      [],
      []
    );
    const fallbackUsed = String(route._source || '').includes('fallback')
      || String(final._source || '').includes('fallback');
    return {
      ok: true,
      message: fallbackUsed
        ? `API kết nối được nhưng model đang mang persona Claude Code. Chế độ tương thích đã hoạt động: Router=${route._source || 'unknown'}, Final=${final._source || 'unknown'}. Chatbot vẫn chạy và tự fallback bằng code khi AI không trả JSON.`
        : `Kết nối thành công cả 2 lần gọi AI. Router: ${route.intent}. Final: ${final.reply}`
    };
  }
}

module.exports = AiService;
