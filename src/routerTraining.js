const fs = require('fs');
const path = require('path');

const POLICY_PATH = path.resolve(__dirname, '..', 'training', 'router-policy.json');

function readPolicy() {
  try {
    return JSON.parse(fs.readFileSync(POLICY_PATH, 'utf8'));
  } catch (error) {
    console.warn(`[ROUTER_TRAINING] Không nạp được ${POLICY_PATH}: ${error.message}`);
    return {};
  }
}

const policy = readPolicy();

function buildRouterTrainingPrompt(catalogSummary = {}) {
  const groupedTypes = (catalogSummary.typeStats || []).reduce((groups, type) => {
    const kind = type.kind || 'other';
    if (!groups[kind]) groups[kind] = [];
    groups[kind].push(type.name);
    return groups;
  }, {});
  const taxonomy = Object.entries(groupedTypes)
    .map(([kind, types]) => `${kind}=[${types.join(', ')}]`)
    .join('; ');
  const typos = Object.entries(policy.contextualTypos || {})
    .map(([meaning, forms]) => `${forms.join('/')}→${meaning}`)
    .join('; ');
  const flexibleAnswers = Object.entries(policy.flexibleAnswers || {})
    .map(([field, forms]) => `${field}=[${forms.join('; ')}]`)
    .join('; ');
  const examples = (policy.examples || []).map((example, index) => {
    const { reply, ...catalogNeutralExample } = example;
    return `E${index + 1} ${JSON.stringify(catalogNeutralExample)}`;
  }).join('\n');

  return [
    taxonomy ? `TAXONOMY_TỪ_CATALOG: ${taxonomy}` : '',
    `CONTEXTUAL_TYPOS: ${typos}`,
    `FLEXIBLE_ANSWERS: ${flexibleAnswers}`,
    'FEW_SHOTS:',
    examples
  ].filter(Boolean).join('\n');
}

module.exports = {
  POLICY_PATH,
  buildRouterTrainingPrompt
};
