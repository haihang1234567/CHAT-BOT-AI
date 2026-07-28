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

module.exports = {
  port: Number(process.env.PORT || 3100),
  shopDomain: String(process.env.SHOP_DOMAIN || 'https://www.greenholdingsport.vn').replace(/\/$/, ''),
  productCsvPath: resolveProjectPath(process.env.PRODUCT_CSV_PATH, './data/products.csv'),
  storePath: resolveProjectPath(process.env.STORE_PATH, './data/local-store.json'),
  adminPassword: String(process.env.ADMIN_PASSWORD || 'change-me'),
  ai: {
    baseUrl: String(process.env.ANTHROPIC_BASE_URL || 'https://llm.wokshop.com').replace(/\/$/, ''),
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
    maxVariants: Number(process.env.AI_MAX_VARIANTS || 10),
    descriptionChars: Number(process.env.AI_DESCRIPTION_CHARS || 650),
    historyMessages: Number(process.env.AI_HISTORY_MESSAGES || 4),
    historyChars: Number(process.env.AI_HISTORY_CHARS || 350),
    routerHistoryMessages: Number(process.env.AI_ROUTER_HISTORY_MESSAGES || 3),
    routerHistoryChars: Number(process.env.AI_ROUTER_HISTORY_CHARS || 220),
    cacheTtlMs: Number(process.env.AI_CACHE_TTL_MS || 1800000),
    alwaysFinal: booleanValue(process.env.AI_ALWAYS_FINAL, true)
  }
};
