const fs = require('fs');
const path = require('path');
const { normalizeText } = require('./productService');

const STOP_WORDS = new Set([
  'ai', 'anh', 'ban', 'cai', 'cho', 'co', 'cua', 'duoc', 'gi', 'hay', 'khach',
  'khong', 'la', 'lam', 'mot', 'nao', 'nen', 'nhu', 'nhung', 'phu', 'sao',
  'the', 'thi', 'toi', 'tu', 'va', 'voi'
]);

function clean(value, maxLength = 1200) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function hostnameOf(rawUrl) {
  try {
    return new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, '');
  } catch (_) {
    return '';
  }
}

function unique(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => clean(value, 180))
    .filter(Boolean))];
}

function tokens(value) {
  return normalizeText(value)
    .split(/\s+/)
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

class LocalKnowledgeService {
  constructor(config = {}) {
    this.config = config;
    this.entries = [];
    this.warnings = [];
    this.load();
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

  jsonFiles(rootPath) {
    if (!rootPath || !fs.existsSync(rootPath)) return [];
    const stat = fs.statSync(rootPath);
    if (stat.isFile()) return rootPath.endsWith('.json') ? [rootPath] : [];

    return fs.readdirSync(rootPath, { withFileTypes: true })
      .flatMap((item) => {
        const itemPath = path.join(rootPath, item.name);
        if (item.isDirectory()) return this.jsonFiles(itemPath);
        return item.isFile() && item.name.endsWith('.json') ? [itemPath] : [];
      });
  }

  normalizeEntry(raw, filePath, index) {
    if (!raw || typeof raw !== 'object' || raw.enabled === false) return null;
    const source = raw.source && typeof raw.source === 'object' ? raw.source : {};
    const sourceUrl = clean(source.url, 600);
    const content = clean(raw.content || raw.answer || raw.facts, this.config.contentChars || 900);
    const expiresAt = raw.expiresAt ? Date.parse(raw.expiresAt) : null;

    if (!raw.id || !raw.title || !content || !sourceUrl) {
      this.warnings.push(`${path.basename(filePath)}#${index + 1}: thiếu id, title, content hoặc source.url.`);
      return null;
    }
    if (!this.isTrustedUrl(sourceUrl)) {
      this.warnings.push(`${raw.id}: source.url không thuộc KNOWLEDGE_OFFICIAL_DOMAINS.`);
      return null;
    }
    if (expiresAt && Number.isFinite(expiresAt) && expiresAt <= Date.now()) return null;

    return {
      id: clean(raw.id, 120),
      title: clean(raw.title, 180),
      sports: unique(raw.sports),
      questions: unique(raw.questions),
      keywords: unique(raw.keywords),
      content,
      source: {
        title: clean(source.title || raw.title, 180),
        url: sourceUrl,
        domain: hostnameOf(sourceUrl)
      },
      verifiedAt: clean(raw.verifiedAt, 40),
      expiresAt: clean(raw.expiresAt, 40)
    };
  }

  load() {
    this.entries = [];
    this.warnings = [];
    if (!this.config.localEnabled) return;

    for (const filePath of this.jsonFiles(this.config.localDir)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.entries) ? parsed.entries : [];
        rows.forEach((row, index) => {
          const entry = this.normalizeEntry(row, filePath, index);
          if (entry) this.entries.push(entry);
        });
      } catch (error) {
        this.warnings.push(`${path.basename(filePath)}: ${error.message}`);
      }
    }

    if (this.warnings.length) {
      console.warn('[LOCAL_KNOWLEDGE_WARN]', JSON.stringify(this.warnings.slice(0, 20)));
    }
    console.log('[LOCAL_KNOWLEDGE]', JSON.stringify({ entries: this.entries.length }));
  }

  score(entry, rawQuery) {
    const query = normalizeText(rawQuery);
    if (!query) return 0;
    const queryTokens = new Set(tokens(query));
    const title = normalizeText(entry.title);
    const sports = entry.sports.map(normalizeText);
    const questions = entry.questions.map(normalizeText);
    const keywords = entry.keywords.map(normalizeText);
    const searchable = normalizeText([
      entry.title,
      ...entry.sports,
      ...entry.questions,
      ...entry.keywords,
      entry.content
    ].join(' '));

    let score = 0;
    if (title && query.includes(title)) score += 8;
    if (questions.some((question) => question && (query.includes(question) || question.includes(query)))) {
      score += 10;
    }
    score += sports.filter((sport) => sport && query.includes(sport)).length * 4;
    score += keywords.filter((keyword) => keyword && query.includes(keyword)).length * 5;
    for (const token of queryTokens) {
      if (searchable.includes(token)) score += 1;
    }
    return score;
  }

  search(rawQuery) {
    const query = clean(rawQuery, 700);
    if (!this.config.localEnabled || !query || !this.entries.length) {
      return {
        query,
        sources: [],
        sufficient: false,
        cached: true,
        provider: 'local'
      };
    }

    const ranked = this.entries
      .map((entry) => ({ entry, score: this.score(entry, query) }))
      .filter((item) => item.score >= this.config.localMinScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, this.config.localMaxResults);

    return {
      query,
      sources: ranked.map(({ entry, score }, index) => ({
        id: index + 1,
        title: entry.source.title,
        url: entry.source.url,
        domain: entry.source.domain,
        content: entry.content,
        score,
        origin: 'local',
        knowledgeId: entry.id,
        verifiedAt: entry.verifiedAt
      })),
      sufficient: Boolean(ranked.length && ranked[0].score >= this.config.localSufficientScore),
      cached: true,
      provider: 'local'
    };
  }
}

module.exports = LocalKnowledgeService;
