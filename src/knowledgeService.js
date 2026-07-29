class KnowledgeService {
  constructor(config = {}, localKnowledge, webKnowledge) {
    this.config = config;
    this.local = localKnowledge;
    this.web = webKnowledge;
  }

  mergeSources(localSources = [], webSources = []) {
    const seen = new Set();
    const sources = [];
    for (const source of [...localSources, ...webSources]) {
      const key = String(source?.url || '').trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      sources.push({ ...source, id: sources.length + 1 });
      if (sources.length >= this.config.maxResults) break;
    }
    return sources;
  }

  async search(rawQuery, options = {}) {
    const originalQuestion = String(options.originalQuestion || '').trim();
    const localQuery = [originalQuestion, rawQuery].filter(Boolean).join(' | ');
    const localResult = this.local.search(localQuery);

    if (localResult.sufficient) {
      return {
        query: rawQuery,
        sources: this.mergeSources(localResult.sources, []),
        cached: true,
        provider: 'local',
        credits: 0,
        warning: ''
      };
    }

    const webResult = await this.web.search(rawQuery);
    const sources = this.mergeSources(localResult.sources, webResult.sources);
    return {
      query: rawQuery,
      sources,
      cached: Boolean(webResult.cached),
      provider: localResult.sources.length ? 'local+web' : 'web',
      credits: Number(webResult.credits || 0),
      warning: sources.length ? '' : webResult.warning
    };
  }
}

module.exports = KnowledgeService;
