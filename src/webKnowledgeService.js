const crypto = require('crypto');

function clean(value, maxLength = 1000) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function hostnameOf(rawUrl) {
  try {
    return new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, '');
  } catch (_) {
    return '';
  }
}

class WebKnowledgeService {
  constructor(config = {}, fetchImpl = global.fetch) {
    this.config = config;
    this.fetch = fetchImpl;
    this.cache = new Map();
  }

  isConfigured() {
    return Boolean(
      this.config.enabled
      && this.config.apiKey
      && this.config.endpoint
      && typeof this.fetch === 'function'
    );
  }

  trustedDomains() {
    return [...new Set((this.config.officialDomains || [])
      .map((domain) => hostnameOf(`https://${String(domain).replace(/^https?:\/\//, '')}`))
      .filter(Boolean))];
  }

  isTrustedUrl(url) {
    const hostname = hostnameOf(url);
    return Boolean(hostname) && this.trustedDomains().some(
      (domain) => hostname === domain || hostname.endsWith(`.${domain}`)
    );
  }

  cacheKey(query) {
    return crypto.createHash('sha1')
      .update(`${clean(query, 500)}|${this.trustedDomains().join(',')}`)
      .digest('hex');
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
    this.cache.set(key, { value, createdAt: Date.now() });
    if (this.cache.size > 500) this.cache.delete(this.cache.keys().next().value);
  }

  async search(rawQuery) {
    const query = clean(rawQuery, 500);
    if (!query) return { sources: [], warning: 'Thiếu câu hỏi để tìm nguồn.' };
    if (!this.isConfigured()) {
      return {
        sources: [],
        warning: 'Chưa cấu hình TAVILY_API_KEY nên không thể kiểm chứng nguồn chính thống.'
      };
    }

    const key = this.cacheKey(query);
    const cached = this.readCache(key);
    if (cached) return cached;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const response = await this.fetch(this.config.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          query,
          topic: 'general',
          search_depth: 'basic',
          max_results: this.config.maxResults,
          include_answer: false,
          include_raw_content: false,
          include_images: false,
          include_domains: this.trustedDomains(),
          auto_parameters: false,
          include_usage: true
        }),
        signal: controller.signal
      });

      const raw = await response.text();
      let data;
      try { data = JSON.parse(raw); } catch (_) { data = { detail: raw }; }
      if (!response.ok) {
        const detail = data?.detail?.error || data?.detail || data?.message || raw.slice(0, 300);
        throw new Error(`Tavily ${response.status}: ${detail}`);
      }

      const sources = (Array.isArray(data?.results) ? data.results : [])
        .filter((item) => this.isTrustedUrl(item?.url))
        .slice(0, this.config.maxResults)
        .map((item, index) => ({
          id: index + 1,
          title: clean(item.title, 160) || hostnameOf(item.url),
          url: clean(item.url, 600),
          domain: hostnameOf(item.url),
          content: clean(item.content, this.config.contentChars),
          score: Number(item.score || 0)
        }))
        .filter((item) => item.url && item.content);

      const result = {
        query,
        sources,
        credits: Number(data?.usage?.credits || 0),
        cached: false,
        warning: sources.length
          ? ''
          : 'Không tìm thấy nguồn chính thống đủ nội dung để trả lời an toàn.'
      };
      this.writeCache(key, result);
      console.log('[WEB_KNOWLEDGE]', JSON.stringify({
        provider: 'tavily',
        queryChars: query.length,
        sources: sources.length,
        credits: result.credits,
        cached: false
      }));
      return result;
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = WebKnowledgeService;
