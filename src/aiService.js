const crypto = require('crypto');
const { normalizeText, canonicalSearchText } = require('./productService');

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

function cleanSuggestions(value, maxItems = 3) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const suggestions = [];
  for (const item of value) {
    const label = cleanString(typeof item === 'string' ? item : item?.label, 70);
    const prompt = cleanString(typeof item === 'string' ? item : item?.prompt || label, 180);
    if (!label || !prompt) continue;
    const key = normalizeText(prompt);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    suggestions.push({ label, prompt });
    if (suggestions.length >= maxItems) break;
  }
  return suggestions;
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

  async call({ model, maxTokens, temperature = 0.1, system, messages, purpose = 'unknown' }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    const body = this.requestBody({ model, maxTokens, temperature, system, messages });
    const promptChars = JSON.stringify(body.messages || []).length + String(body.system || '').length;

    try {
      const response = await fetch(this.endpoint(), {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
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
      const usage = data?.usage || {};
      const inputTokens = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0);
      const outputTokens = Number(usage.output_tokens ?? usage.completion_tokens ?? 0);
      const cacheReadTokens = Number(usage.cache_read_input_tokens ?? usage.cache_read_tokens ?? 0);
      const cacheWriteTokens = Number(usage.cache_creation_input_tokens ?? usage.cache_write_tokens ?? 0);
      console.log('[AI_USAGE]', JSON.stringify({
        purpose,
        model: data?.model || model,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        promptChars,
        responseChars: text.length
      }));
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
      'Bạn phân tích ý định cho chatbot thể thao Green Holding Sport và chỉ trả JSON.',
      'Tách rõ hai nhánh: tìm/tư vấn sản phẩm và hỏi kiến thức.',
      'Với sản phẩm, suy luận đầy đủ khách cần gì: bộ môn, loại hàng, mục đích, môi trường/mặt sân, đặc điểm người dùng, hãng, size, màu, ngân sách và tồn kho.',
      'requirements là điều kiện bắt buộc; preferences là ưu tiên. Không tự hạ điều kiện bắt buộc để lấy sản phẩm gần đúng.',
      'Mỗi requirements/preferences là một nhóm OR; nhiều nhóm khác nhau phải đồng thời thỏa mãn.',
      'Dùng scope=identity cho bộ môn, loại hàng, dòng sản phẩm hoặc mã kỹ thuật; scope=details cho tính năng và nhu cầu sử dụng.',
      'Với câu hỏi kiến thức, đặt intent=general_question, needWeb=true, showProducts=false và viết webQuery ngắn gọn để tìm nguồn chính thống.',
      'Không tự trả lời kiến thức trong bước này. Backend sẽ tìm nguồn rồi mới gọi AI tổng hợp.',
      'Nếu câu hỏi thiếu thông tin có thể làm chọn sai sản phẩm, responseMode=clarify và hỏi đúng một câu.',
      'Chỉ dùng HISTORY khi khách tham chiếu rõ “mẫu này”, “đôi trên”, “các mẫu vừa gợi ý”.',
      'Giá đổi thành VND nguyên. Không viết SQL, không bịa dữ liệu và không thêm trường ngoài schema.',
      'JSON_SCHEMA:',
      '{"intent":"greeting|thanks|search_by_code|search_product|product_detail|product_recommendation|compare_products|create_order|order_help|admin_handoff|general_question|unknown","needDatabase":true,"needWeb":false,"webQuery":"","showProducts":true,"needsAdmin":false,"responseMode":"brief|detail|recommend|compare|order|clarify","clarificationQuestion":"","search":{"query":"","codes":[],"productIds":[],"names":[],"brands":[],"categories":[],"colors":[],"sizes":[],"customerNeeds":[],"requirements":[{"label":"","terms":[],"scope":"identity|details"}],"preferences":[{"label":"","terms":[],"scope":"identity|details"}],"excludeTerms":[],"minPrice":null,"maxPrice":null,"inStockOnly":false,"limit":3}}'
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

  buildKnowledgeUserPrompt(payload) {
    return [
      'Bạn là tư vấn viên thể thao Green Holding Sport.',
      'Chỉ trả lời câu hỏi bằng thông tin có trong SOURCES. Không dùng trí nhớ để bổ sung dữ kiện.',
      'Nếu SOURCES không đủ chứng minh, nói rõ chưa đủ nguồn; tuyệt đối không đoán.',
      'Viết tiếng Việt tự nhiên, ngắn gọn 2-5 câu. Đặt ký hiệu [1], [2] ngay sau ý được nguồn hỗ trợ.',
      'Không giới thiệu sản phẩm, không tạo ảnh/thẻ sản phẩm.',
      'Chỉ dùng citationIds có trong SOURCES và tối đa 3 gợi ý hỏi tiếp.',
      'Trả đúng JSON, không markdown:',
      '{"reply":"...","citationIds":[1],"suggestions":[{"label":"...","prompt":"..."}]}',
      'INPUT_JSON:',
      JSON.stringify(payload),
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
      /\b(cach bao quan|cach ve sinh|giat giay|la gi|tai sao|khac nhau giua|khac nhau the nao|huong dan su dung)\b/
    ].some((pattern) => pattern.test(q));
    if (textOnly) return false;

    const explicitlyWantsProducts = [
      /\b(tim|goi y|cho xem|xem cac mau|co mau nao|co doi nao|co san pham nao)\b/,
      /\bco .{0,30}(giay|vot|bong|ao|quan|balo|ba lo|tui|tat) .{0,30}(khong|nao)\b/,
      /\b(mua|chon giup|them vao don|dat hang)\b/,
      /\b(so sanh) .{0,50}\b(mau|doi|san pham)\b/
    ].some((pattern) => pattern.test(q));
    if (explicitlyWantsProducts) return true;
    return null;
  }

  isKnowledgeQuestion(message) {
    const q = normalizeText(message);
    if (this.codeShowProducts(message) === true) return false;
    return [
      /\b(la gi|tai sao|vi sao|khac nhau|giai thich|kien thuc|quy tac|luat choi)\b/,
      /\b(cach bao quan|cach ve sinh|giat giay|huong dan su dung|chon size|quy doi size)\b/,
      /\b(co nen|dung duoc khong|phu hop khong|anh huong gi|tac dung gi)\b/,
      /\b(giai thich chi tiet hon|noi ro hon|phan mo rong|cau tra loi vua roi)\b/
    ].some((pattern) => pattern.test(q));
  }

  needsProductKnowledge(message, history = []) {
    const q = normalizeText(message);
    const hasContextReference = /\b(mau nay|san pham nay|doi nay|cai nay|mau tren|san pham tren|doi tren|cac mau tren|nhung mau tren|mau vua goi y|cac mau vua goi y|cac san pham vua goi y)\b/.test(q);
    const hasContextProduct = history.some((item) => (
      (Array.isArray(item?.contextProductIds) && item.contextProductIds.length)
      || (Array.isArray(item?.productIds) && item.productIds.length)
    ));
    const asksStoredDetails = /\b(cong nghe|chat lieu|thong so|bao hanh|xuat xu|mo ta)\b/.test(q);
    const looksLikeCode = (String(message || '').match(/\b[A-Za-z0-9][A-Za-z0-9._/-]{4,}\b/g) || [])
      .some((token) => /[A-Za-z]/.test(token) && /\d/.test(token));
    return looksLikeCode || asksStoredDetails || (hasContextReference && hasContextProduct);
  }

  shouldUseAiRouter(message, route) {
    if (!route) return true;
    if (['greeting', 'thanks', 'admin_handoff'].includes(route.intent)) return false;
    if (this.productService.exactLookup(message)) return false;
    if ((route.search?.productIds || []).length && /\b(mau|size|gia|con hang|het hang|chi tiet|so sanh)\b/.test(normalizeText(message))) {
      return false;
    }
    if (this.config.routerAlways) return true;

    const search = route.search || {};
    const hasCodeSignals = [
      search.codes, search.productIds, search.brands, search.categories,
      search.colors, search.sizes, search.customerNeeds,
      search.requirements, search.preferences, search.excludeTerms
    ].some((value) => Array.isArray(value) && value.length)
      || search.minPrice !== null
      || search.maxPrice !== null
      || Boolean(search.inStockOnly);
    if (hasCodeSignals) return false;

    const q = canonicalSearchText(message);
    const hasCommerceWords = /\b(tim|mua|giay|vot|bong|ao|quan|balo|tui|tat|size|mau|gia|san pham)\b/.test(q);
    return !hasCommerceWords;
  }

  codeSearchRules(message) {
    const q = canonicalSearchText(message);
    const categoryRules = [
      ['giay bong chuyen', /\b(giay bong chuyen|bong chuyen)\b/],
      ['bong da', /\b(giay bong da|giay da bong|giay (?:da )?san (?:5|7|11)|bong da|san co nhan tao|futsal)\b/],
      ['giay chay bo', /\b(giay chay bo|giay chay|chay bo|chay dia hinh|running|trail running)\b/],
      ['giay cau long', /\b(giay cau long)\b/],
      ['vot cau long', /\b(vot cau long)\b/],
      ['pickleball', /\bpickleball\b/],
      ['giay tennis', /\b(giay tennis|tennis)\b/],
      ['giay bong ro', /\b(giay bong ro|bong ro)\b/],
      ['bong ban', /\b(bong ban)\b/],
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
    const productKindRules = [
      { kind: 'shoe', label: 'Giày', terms: ['giày'], pattern: /\b(giay|sneaker|doi giay)\b/ },
      { kind: 'racket', label: 'Vợt', terms: ['vợt'], pattern: /\b(vot)\b/ },
      { kind: 'ball', label: 'Quả bóng', terms: ['quả bóng', 'bóng thi đấu'], pattern: /\b(qua bong|trai bong|bong thi dau)\b/ },
      { kind: 'shirt', label: 'Áo', terms: ['áo'], pattern: /\b(ao|polo|tee|tank top|jacket)\b/ },
      { kind: 'pants', label: 'Quần', terms: ['quần', 'short'], pattern: /\b(quan|short)\b/ },
      { kind: 'socks', label: 'Tất', terms: ['tất', 'vớ'], pattern: /\b(tat|vo)\b/ },
      { kind: 'bag', label: 'Balo hoặc túi', terms: ['balo', 'ba lô', 'túi'], pattern: /\b(balo|ba lo|tui)\b/ }
    ];
    const productKind = productKindRules.find((rule) => rule.pattern.test(q)) || null;
    if (productKind) {
      requirements.push({
        label: `Loại sản phẩm: ${productKind.label}`,
        terms: productKind.terms,
        scope: 'identity'
      });
      customerNeeds.push(`Đúng loại sản phẩm ${productKind.label.toLowerCase()}`);
    }

    const isFootball = categories.includes('bong da');
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
      inStockOnly: /\b(con hang|co hang|san pham san co)\b/.test(q),
      productKind: productKind?.kind || ''
    };
  }

  detectedProductKind(value) {
    const text = canonicalSearchText(value);
    const rules = [
      ['shoe', /\b(giay|sneaker)\b/],
      ['racket', /\b(vot)\b/],
      ['ball', /\b(qua bong|trai bong|bong thi dau)\b/],
      ['shirt', /\b(ao|polo|tee|tank top|jacket)\b/],
      ['pants', /\b(quan|short)\b/],
      ['socks', /\b(tat|vo)\b/],
      ['bag', /\b(balo|ba lo|tui)\b/]
    ];
    return rules.find(([, pattern]) => pattern.test(text))?.[0] || '';
  }

  applyCodeClarification(route, message, rules = this.codeSearchRules(message)) {
    const q = canonicalSearchText(message);
    const incompleteProductQuestion = /^(?:co )?(?:giay|vot|ao|quan|balo|ba lo|tui)(?: di| nao| khong)?$/.test(q);
    const hasUsefulConstraint = Boolean(
      rules.categories.length || rules.brands.length || rules.colors.length || rules.sizes.length
      || rules.minPrice !== null || rules.maxPrice !== null
    );
    if (!incompleteProductQuestion || hasUsefulConstraint) return route;

    const kind = rules.productKind === 'racket' ? 'vợt' : rules.productKind === 'shoe' ? 'giày' : 'sản phẩm';
    return {
      ...route,
      responseMode: 'clarify',
      clarificationQuestion: `Bạn đang tìm ${kind} cho bộ môn hoặc nhu cầu nào? Ví dụ: bóng đá, chạy bộ, bóng chuyền, cầu lông, tennis hoặc pickleball.`,
      showProducts: false
    };
  }

  mergeCodeRules(route, message) {
    const rules = this.codeSearchRules(message);
    const codeShowProducts = this.codeShowProducts(message);
    const search = route.search || {};
    const knownSurface = rules.requirements.some((group) => (
      group.scope === 'identity'
      && /mặt sân|bóng đá trong nhà/i.test(group.label || '')
    ));
    const surfaceTerms = new Set([
      'tf', 'as', 'fg', 'sg', 'ag', 'ic', 'in', 'turf',
      'co nhan tao', 'co tu nhien', 'dinh dam', 'firm ground', 'futsal', 'san trong nha'
    ]);
    const aiRequirements = (search.requirements || []).filter((group) => {
      const aiKind = this.detectedProductKind((group.terms || []).join(' '));
      if (rules.productKind && aiKind && aiKind !== rules.productKind) return false;
      if (!knownSurface) return true;
      return !(group.terms || []).some((term) => surfaceTerms.has(normalizeText(term)));
    });
    const aiExcludeTerms = (search.excludeTerms || []).filter((term) => {
      return !knownSurface || !surfaceTerms.has(normalizeText(term));
    });
    const beigeExplicit = /\b(?:mau|color)\s+(?:be|beige)\b|\bbeige\b/.test(normalizeText(message));
    const aiColors = (search.colors || []).filter((color) => normalizeText(color) !== 'be' || beigeExplicit);

    const aiCategories = (search.categories || []).filter((category) => {
      const aiKind = this.detectedProductKind(category);
      return !rules.productKind || !aiKind || aiKind === rules.productKind;
    });

    return this.applyCodeClarification({
      ...route,
      showProducts: codeShowProducts === null ? route.showProducts : codeShowProducts,
      search: {
        ...search,
        brands: uniqueStrings([...(rules.brands || []), ...(search.brands || [])]),
        categories: uniqueStrings([...(rules.categories || []), ...aiCategories]),
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
    }, message, rules);
  }

  fallbackRoute(message, history = [], warning = '') {
    const q = normalizeText(message);
    const compactHistory = this.compactHistory(history, {
      limit: this.config.routerHistoryMessages,
      maxChars: this.config.routerHistoryChars
    });
    const historyIds = [...new Set(compactHistory.flatMap((item) => item.productIds || []))].slice(-5);
    const contextReference = /\b(mau nay|san pham nay|doi nay|cai nay|mau tren|san pham tren|doi tren|cac mau tren|nhung mau tren|mau vua goi y|cac mau vua goi y|cac san pham vua goi y)\b/.test(q);
    const codeTokens = String(message || '').match(/\b[A-Za-z0-9][A-Za-z0-9._/-]{4,}\b/g) || [];
    const codes = [...new Set(codeTokens.filter((token) => /[A-Za-z]/.test(token) && /\d/.test(token)))].slice(0, 10);
    const codeRules = this.codeSearchRules(message);
    const knowledgeQuestion = this.isKnowledgeQuestion(message);

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
    } else if (knowledgeQuestion) {
      intent = 'general_question';
      responseMode = /\b(chi tiet|ro hon|mo rong)\b/.test(q) ? 'detail' : 'brief';
      needDatabase = this.needsProductKnowledge(message, history);
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
      needFinalAi: !['greeting', 'thanks', 'admin_handoff'].includes(intent),
      showProducts: knowledgeQuestion ? false : this.codeShowProducts(message) ?? [
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
      ...this.applyCodeClarification(this.normalizeRoute(raw, message), message, codeRules),
      _source: 'code-router',
      _warning: cleanString(warning, 500)
    };
  }

  fallbackSuggestions(message, route, candidates = []) {
    if (route?.responseMode === 'clarify') return [];
    if (route?.intent === 'general_question' || route?.showProducts === false) {
      return cleanSuggestions([
        { label: 'Xem giải thích chi tiết', prompt: 'Hãy giải thích chi tiết hơn câu trả lời vừa rồi' },
        { label: 'Tìm sản phẩm phù hợp', prompt: `Tư vấn sản phẩm phù hợp dựa trên câu hỏi: ${cleanString(message, 100)}` },
        { label: 'Hỏi cách lựa chọn', prompt: 'Hướng dẫn tôi cách lựa chọn phù hợp với nhu cầu của mình' }
      ]);
    }
    if (candidates.length) {
      return cleanSuggestions([
        { label: 'Kiểm tra màu và size', prompt: 'Kiểm tra màu và size còn hàng của các mẫu vừa gợi ý' },
        { label: 'So sánh các mẫu', prompt: 'So sánh ngắn gọn các mẫu sản phẩm vừa gợi ý' },
        { label: 'Lọc theo ngân sách', prompt: 'Hãy hỏi ngân sách của tôi rồi lọc lại sản phẩm phù hợp' }
      ]);
    }
    return cleanSuggestions([
      { label: 'Tìm theo bộ môn', prompt: 'Hãy hỏi bộ môn tôi cần rồi tìm sản phẩm phù hợp' },
      { label: 'Tìm theo ngân sách', prompt: 'Hãy hỏi ngân sách của tôi rồi tìm sản phẩm phù hợp' }
    ]);
  }

  fallbackFinal(message, route, candidates = [], warning = '') {
    const productIds = candidates.slice(0, 5).map((item) => String(item.id));
    let reply;

    if (route?.intent === 'greeting') {
      return {
        reply: 'Xin chào! Bạn đang cần tư vấn sản phẩm, size hay kiến thức về bộ môn nào?',
        productIds: [],
        suggestions: cleanSuggestions([
          { label: 'Tư vấn sản phẩm', prompt: 'Tư vấn sản phẩm phù hợp với nhu cầu của tôi' },
          { label: 'Hướng dẫn chọn size', prompt: 'Hướng dẫn tôi cách chọn size phù hợp' }
        ]),
        needsAdmin: false,
        _source: 'code-final'
      };
    }
    if (route?.intent === 'thanks') {
      return {
        reply: 'Rất vui vì đã hỗ trợ được bạn. Khi cần tìm sản phẩm hoặc kiểm tra size, màu và tồn kho, bạn cứ nhắn mình nhé.',
        productIds: [],
        suggestions: [],
        needsAdmin: false,
        _source: 'code-final'
      };
    }

    if (route?.showProducts === false) {
      const q = normalizeText(message);
      const footLength = q.match(/(\d+(?:\.\d+)?)\s*cm/);
      if (route.responseMode === 'clarify' && route.clarificationQuestion) {
        reply = route.clarificationQuestion;
      } else if (footLength && /\b(chieu dai ban chan|do dai ban chan|ban chan|size)\b/.test(q)) {
        reply = `Bàn chân dài ${footLength[1]} cm chưa thể chốt một size chung cho mọi mẫu vì mỗi dòng giày có bảng quy đổi khác nhau. Bạn cho mình biết đúng tên mẫu hoặc mã sản phẩm đang quan tâm, mình sẽ đối chiếu size phù hợp và không cần hiển thị lại danh sách ảnh.`;
      } else {
        reply = 'Mình hiểu đây là câu hỏi chỉ cần trả lời bằng thông tin, không cần hiển thị sản phẩm. Hiện AI đang tạm thời chưa kết nối nên mình chưa muốn suy đoán; bạn thử gửi lại sau ít phút hoặc gõ “admin” để được hỗ trợ chính xác.';
      }
      return {
        reply,
        productIds: [],
        suggestions: this.fallbackSuggestions(message, route, candidates),
        needsAdmin: false,
        _source: 'code-final-fallback',
        _warning: cleanString(warning, 500)
      };
    }

    if (!candidates.length) {
      const analyzedNeeds = cleanList(route?.search?.customerNeeds, 4, 100);
      const needText = analyzedNeeds.length ? ` theo yêu cầu: ${analyzedNeeds.join(', ')}` : '';
      reply = `Mình chưa tìm thấy sản phẩm đáp ứng đủ${needText} trong kho hiện tại. Mình không thay bằng sản phẩm sai bộ môn hoặc sai điều kiện; bạn có thể đổi một tiêu chí hoặc gõ “admin” để nhân viên kiểm tra thêm.`;
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
      suggestions: this.fallbackSuggestions(message, route, candidates),
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
    const neverNeedsFinalAi = ['greeting', 'thanks', 'admin_handoff'].includes(intent)
      || String(raw?.responseMode) === 'clarify';
    const isKnowledge = intent === 'general_question';
    const isProductFlow = needDatabaseByIntent;

    const normalized = {
      intent,
      needDatabase: raw?.needDatabase === undefined ? needDatabaseByIntent : Boolean(raw.needDatabase),
      needWeb: isKnowledge ? raw?.needWeb !== false : Boolean(raw?.needWeb),
      webQuery: cleanString(raw?.webQuery || (isKnowledge ? message : ''), 500),
      needFinalAi: neverNeedsFinalAi
        ? false
        : isKnowledge
          ? true
          : isProductFlow
            ? Boolean(this.config.productFinalEnabled)
            : Boolean(raw?.needFinalAi),
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
    const localRoute = this.fallbackRoute(message, history);
    if (!this.shouldUseAiRouter(message, localRoute)) {
      this.writeCache(key, localRoute);
      return localRoute;
    }

    const text = await this.call({
      model: this.config.routerModel,
      maxTokens: this.config.routerMaxTokens,
      temperature: 0,
      system: '',
      messages: [{ role: 'user', content: this.buildRouterUserPrompt(payload) }],
      purpose: 'router'
    });

    const parsed = this.parseJson(text);
    let result;
    if (!parsed) {
      const warning = `AI Router không trả JSON; đã dùng Router bằng code. Phản hồi AI: ${text.slice(0, 220)}`;
      console.warn(warning);
      result = this.fallbackRoute(message, history, warning);
    } else {
      result = {
        ...this.normalizeRoute(parsed, message),
        _source: 'ai-router'
      };
    }
    this.writeCache(key, result);
    return result;
  }

  buildFinalSystemPrompt() {
    return [
      'Bạn là nhân viên tư vấn Green Holding Sport, trả lời tự nhiên như người thật.',
      'Backend đã phân tích câu hỏi và truy vấn dữ liệu bằng code; hãy viết câu trả lời cuối thật ngắn gọn.',
      'Đối chiếu customerNeeds, requirements, preferences, excludeTerms và ngân sách trong ROUTE.',
      'Thông tin sản phẩm chỉ được lấy từ DATABASE_RESULTS. Không bịa giá, tồn kho, màu, size, mã, công nghệ hoặc chính sách.',
      'Không gọi một sản phẩm là phù hợp nếu tên, loại, mô tả hoặc biến thể mâu thuẫn với điều kiện bắt buộc của khách.',
      'Không có sản phẩm đáp ứng đủ điều kiện thì nói rõ và để productIds=[]. Không chọn gần đúng để đủ số lượng.',
      'ROUTE.showProducts=false: chỉ trả lời kiến thức bằng text trong 2-4 câu, không liệt kê sản phẩm, productIds=[].',
      'ROUTE.responseMode=detail chỉ khi khách chủ động bấm xem chi tiết; khi đó có thể giải thích dài hơn.',
      'Tồn kho chỉ nói “Còn hàng” hoặc “Hết hàng”, không nói số lượng.',
      'Ảnh, màu, size, SKU và biến thể do giao diện dựng bằng code; không chép lại toàn bộ vào reply.',
      'Chọn tối đa 3 productIds có trong DATABASE_RESULTS.',
      'Không được trả productId không tồn tại trong DATABASE_RESULTS.',
      'Tạo tối đa 3 suggestions ngắn để khách hỏi tiếp. Với câu kiến thức nên có “Xem giải thích chi tiết” và một gợi ý tìm sản phẩm; với câu sản phẩm nên gợi ý kiểm tra màu/size hoặc so sánh.',
      'Mỗi suggestion gồm label hiển thị và prompt đầy đủ để gửi lại khi khách bấm.',
      'Trả đúng JSON, không markdown:',
      '{"reply":"...","productIds":["..."],"suggestions":[{"label":"...","prompt":"..."}],"needsAdmin":false}'
    ].join('\n');
  }

  answerLimits(message, route) {
    const qualityMode = this.config.costMode === 'quality';
    const q = normalizeText(message);
    const includeVariants = /\b(size|mau|sku|barcode|ma phien ban|con hang|het hang|gia)\b/.test(q);
    return {
      maxProducts: qualityMode
        ? Math.max(1, Number(this.config.maxCandidates || 5))
        : Math.min(3, Math.max(1, Number(this.config.maxCandidates || 3))),
      maxVariants: qualityMode
        ? Math.max(1, Number(this.config.maxVariants || 10))
        : Math.min(4, Math.max(1, Number(this.config.maxVariants || 4))),
      descriptionChars: qualityMode
        ? Math.max(100, Number(this.config.descriptionChars || 650))
        : Math.min(260, Math.max(100, Number(this.config.descriptionChars || 260))),
      historyMessages: qualityMode
        ? Math.max(1, Number(this.config.historyMessages || 4))
        : Math.min(2, Math.max(1, Number(this.config.historyMessages || 2))),
      historyChars: qualityMode
        ? Math.max(80, Number(this.config.historyChars || 350))
        : Math.min(220, Math.max(80, Number(this.config.historyChars || 220))),
      maxTokens: qualityMode
        ? Math.max(120, Number(this.config.finalMaxTokens || 520))
        : Math.min(320, Math.max(160, Number(this.config.finalMaxTokens || 320))),
      includeVariants: Boolean(route?.needDatabase && includeVariants)
    };
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

  async answer(message, route, candidates = [], history = [], options = {}) {
    if (!this.isConfigured()) return null;

    const limits = this.answerLimits(message, route);
    const limitedCandidates = candidates.slice(0, limits.maxProducts);
    const key = this.finalCacheKey(message, route, limitedCandidates, history);
    const cached = this.readCache(key);
    if (cached) return cached;

    const databaseResults = this.productService.compactForAi(limitedCandidates, message, {
      maxProducts: limits.maxProducts,
      maxVariants: limits.maxVariants,
      descriptionChars: limits.descriptionChars,
      includeVariants: limits.includeVariants,
      maxColors: 8,
      maxSizes: 14
    });
    const payload = {
      customerMessage: cleanString(message, 1500),
      route,
      recentHistory: this.compactHistory(history, {
        limit: limits.historyMessages,
        maxChars: limits.historyChars
      }),
      databaseResults
    };

    const text = await this.call({
      model: this.config.chatModel,
      maxTokens: limits.maxTokens,
      temperature: 0.2,
      system: '',
      messages: [{ role: 'user', content: this.buildFinalUserPrompt(payload) }],
      purpose: options.purpose || 'chat-final'
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
          productIds: route?.showProducts === false
            ? []
            : limitedCandidates.slice(0, 3).map((item) => item.id),
          suggestions: this.fallbackSuggestions(message, route, limitedCandidates),
          needsAdmin: false,
          _source: 'ai-final-text'
        };
      } else {
        result = this.fallbackFinal(message, route, limitedCandidates, 'AI Final không trả nội dung.');
      }
    } else {
      const allowedIds = new Set(limitedCandidates.map((item) => String(item.id)));
      const productIds = Array.isArray(parsed.productIds)
        ? parsed.productIds.map(String).filter((id) => allowedIds.has(id)).slice(0, 3)
        : [];
      result = {
        reply: cleanString(parsed.reply, 3500),
        productIds: route?.showProducts === false
          ? []
          : Array.isArray(parsed.productIds)
            ? productIds
            : limitedCandidates.slice(0, 3).map((item) => item.id),
        suggestions: cleanSuggestions(parsed.suggestions).length
          ? cleanSuggestions(parsed.suggestions)
          : this.fallbackSuggestions(message, route, limitedCandidates),
        needsAdmin: Boolean(parsed.needsAdmin),
        _source: 'ai-final'
      };
    }

    this.writeCache(key, result);
    return result;
  }

  async answerKnowledge(message, route, sources = [], history = [], options = {}) {
    const safeSources = (Array.isArray(sources) ? sources : [])
      .slice(0, 3)
      .map((source, index) => ({
        id: Number(source.id || index + 1),
        title: cleanString(source.title, 160),
        url: cleanString(source.url, 600),
        domain: cleanString(source.domain, 160),
        content: cleanString(source.content, 650)
      }))
      .filter((source) => source.url && source.content);

    if (!safeSources.length) {
      return {
        reply: 'Mình chưa tìm được nguồn chính thống đủ rõ để trả lời chắc chắn nên sẽ không suy đoán. Bạn có thể thử hỏi cụ thể hơn hoặc gõ “admin” để nhân viên kiểm tra giúp.',
        productIds: [],
        sources: [],
        suggestions: cleanSuggestions([
          { label: 'Hỏi cụ thể hơn', prompt: `Giải thích chính xác và có nguồn về: ${cleanString(message, 110)}` },
          { label: 'Gặp nhân viên', prompt: 'admin' }
        ]),
        needsAdmin: false,
        _source: 'knowledge-no-source'
      };
    }

    const payload = {
      question: cleanString(message, 1000),
      analyzedIntent: {
        webQuery: cleanString(route?.webQuery, 500),
        customerNeeds: cleanList(route?.search?.customerNeeds, 8, 140),
        responseMode: route?.responseMode || 'brief'
      },
      recentHistory: this.compactHistory(history, { limit: 1, maxChars: 180 }),
      sources: safeSources
    };
    const key = this.cacheKey('knowledge-final', payload);
    const cached = this.readCache(key);
    if (cached) return cached;

    const text = await this.call({
      model: this.config.chatModel,
      maxTokens: Math.min(320, Math.max(180, Number(this.config.finalMaxTokens || 280))),
      temperature: 0,
      system: '',
      messages: [{ role: 'user', content: this.buildKnowledgeUserPrompt(payload) }],
      purpose: options.purpose || 'knowledge-final'
    });

    const parsed = this.parseJson(text);
    const allowedIds = new Set(safeSources.map((source) => source.id));
    const citationIds = Array.isArray(parsed?.citationIds)
      ? parsed.citationIds.map(Number).filter((id) => allowedIds.has(id)).slice(0, 3)
      : [];
    const selectedSources = safeSources.filter((source) => (
      citationIds.length ? citationIds.includes(source.id) : true
    ));
    const result = {
      reply: cleanString(parsed?.reply || text, 3000),
      productIds: [],
      sources: selectedSources.map(({ id, title, url, domain }) => ({ id, title, url, domain })),
      suggestions: cleanSuggestions(parsed?.suggestions).length
        ? cleanSuggestions(parsed.suggestions)
        : this.fallbackSuggestions(message, { ...route, showProducts: false }, []),
      needsAdmin: false,
      _source: 'knowledge-grounded-ai'
    };
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

    const testMessage = 'Tư vấn giày thể thao phù hợp với nhu cầu của tôi';
    const route = await this.route(testMessage, []);
    const fallbackUsed = String(route?._source || '').includes('fallback');
    return {
      ok: true,
      message: fallbackUsed
        ? `API kết nối được nhưng Router không trả JSON chuẩn; hệ thống đang dùng fallback bằng code: ${route?._source || 'unknown'}.`
        : `Kết nối thành công. Haiku đã phân tích được câu hỏi thành intent=${route?.intent || 'unknown'}; câu hỏi sản phẩm chỉ cần một lần gọi AI.`
    };
  }
}

module.exports = AiService;
