const path = require('path');

function resolveProjectPath(value, fallback) {
  const candidate = value || fallback;
  return path.isAbsolute(candidate)
    ? candidate
    : path.resolve(__dirname, '..', candidate);
}

function booleanValue(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

const sharedModel = String(process.env.AI_MODEL || '');
const haravanToken = String(process.env.HARAVAN_ACCESS_TOKEN || '').trim();
const productSource = String(process.env.PRODUCT_SOURCE || (haravanToken ? 'haravan' : 'csv'))
  .trim()
  .toLowerCase();
const aiCostMode = String(process.env.AI_COST_MODE || 'balanced').trim().toLowerCase();
const defaultOfficialDomains = [
  'fifa.com',
  'theifab.com',
  'bwfbadminton.com',
  'fivb.com',
  'worldathletics.org',
  'fiba.basketball',
  'itftennis.com',
  'ittf.com',
  'usapickleball.org',
  'olympics.com',
  'mizuno.com',
  'mizunousa.com',
  'asics.com',
  'nike.com',
  'adidas.com',
  'joma-sport.com'
];

module.exports = {
  port: Number(process.env.PORT || 3100),
  shopDomain: String(process.env.SHOP_DOMAIN || 'https://www.greenholdingsport.vn').replace(/\/$/, ''),
  productCsvPath: resolveProjectPath(process.env.PRODUCT_CSV_PATH, './data/products.csv'),
  storePath: resolveProjectPath(process.env.STORE_PATH, './data/local-store.json'),
  adminPassword: String(process.env.ADMIN_PASSWORD || '123456'),
  productSource: ['haravan', 'csv'].includes(productSource) ? productSource : 'csv',
  haravan: {
    baseUrl: String(process.env.HARAVAN_API_BASE_URL || 'https://apis.haravan.com/com').replace(/\/$/, ''),
    token: haravanToken,
    timeoutMs: Math.max(3000, Number(process.env.HARAVAN_TIMEOUT_MS || 30000)),
    pageSize: Math.max(1, Math.min(250, Number(process.env.HARAVAN_PAGE_SIZE || 50))),
    syncIntervalMs: Math.max(60000, Number(process.env.HARAVAN_SYNC_INTERVAL_MS || 600000)),
    includeUnpublished: booleanValue(process.env.HARAVAN_INCLUDE_UNPUBLISHED, false),
    useLocationInventory: booleanValue(process.env.HARAVAN_USE_LOCATION_INVENTORY, true),
    locationIds: String(process.env.HARAVAN_LOCATION_IDS || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
    fallbackToCsv: booleanValue(process.env.HARAVAN_FALLBACK_TO_CSV, true)
  },
  ai: {
    baseUrl: String(process.env.ANTHROPIC_BASE_URL || 'https://llm.wokushop.com').replace(/\/$/, ''),
    token: String(process.env.ANTHROPIC_AUTH_TOKEN || ''),
    model: sharedModel,
    routerModel: String(process.env.AI_ROUTER_MODEL || sharedModel),
    chatModel: String(process.env.AI_CHAT_MODEL || sharedModel),
    style: String(process.env.AI_API_STYLE || 'anthropic').toLowerCase(),
    messagesPath: String(process.env.AI_MESSAGES_PATH || '/v1/messages'),
    authMode: String(process.env.AI_AUTH_MODE || 'bearer').toLowerCase(),
    anthropicVersion: String(process.env.ANTHROPIC_VERSION || '2023-06-01'),
    routerMaxTokens: Number(process.env.AI_ROUTER_MAX_TOKENS || 240),
    finalMaxTokens: Number(process.env.AI_FINAL_MAX_TOKENS || process.env.AI_MAX_TOKENS || 520),
    timeoutMs: Number(process.env.AI_TIMEOUT_MS || 45000),
    maxCandidates: Number(process.env.AI_MAX_CANDIDATES || 5),
    chatProductPageSize: Math.max(1, Math.min(5, Number(process.env.CHAT_PRODUCT_PAGE_SIZE || 5))),
    maxVariants: Number(process.env.AI_MAX_VARIANTS || 10),
    descriptionChars: Number(process.env.AI_DESCRIPTION_CHARS || 650),
    historyMessages: Number(process.env.AI_HISTORY_MESSAGES || 4),
    historyChars: Number(process.env.AI_HISTORY_CHARS || 350),
    routerHistoryMessages: Number(process.env.AI_ROUTER_HISTORY_MESSAGES || 3),
    routerHistoryChars: Number(process.env.AI_ROUTER_HISTORY_CHARS || 220),
    cacheTtlMs: Number(process.env.AI_CACHE_TTL_MS || 1800000),
    alwaysFinal: booleanValue(process.env.AI_ALWAYS_FINAL, true),
    routerAlways: booleanValue(process.env.AI_ROUTER_ALWAYS, true),
    productFinalEnabled: booleanValue(process.env.AI_PRODUCT_FINAL_ENABLED, false),
    costMode: ['balanced', 'quality'].includes(aiCostMode) ? aiCostMode : 'balanced'
  },
  knowledge: {
    enabled: booleanValue(process.env.KNOWLEDGE_WEB_ENABLED, true),
    localEnabled: booleanValue(process.env.KNOWLEDGE_LOCAL_ENABLED, true),
    localDir: resolveProjectPath(process.env.KNOWLEDGE_LOCAL_DIR, './knowledge'),
    localMaxResults: Math.max(1, Math.min(5, Number(process.env.KNOWLEDGE_LOCAL_MAX_RESULTS || 3))),
    localMinScore: Math.max(1, Number(process.env.KNOWLEDGE_LOCAL_MIN_SCORE || 2)),
    localSufficientScore: Math.max(2, Number(process.env.KNOWLEDGE_LOCAL_SUFFICIENT_SCORE || 8)),
    endpoint: String(process.env.TAVILY_API_URL || 'https://api.tavily.com/search'),
    apiKey: String(process.env.TAVILY_API_KEY || '').trim(),
    timeoutMs: Math.max(3000, Number(process.env.KNOWLEDGE_WEB_TIMEOUT_MS || 15000)),
    maxResults: Math.max(1, Math.min(5, Number(process.env.KNOWLEDGE_WEB_MAX_RESULTS || 3))),
    contentChars: Math.max(200, Math.min(1000, Number(process.env.KNOWLEDGE_WEB_CONTENT_CHARS || 550))),
    cacheTtlMs: Math.max(60000, Number(process.env.KNOWLEDGE_WEB_CACHE_TTL_MS || 86400000)),
    officialDomains: String(process.env.KNOWLEDGE_OFFICIAL_DOMAINS || defaultOfficialDomains.join(','))
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
  }
};
