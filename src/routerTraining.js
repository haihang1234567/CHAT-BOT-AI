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

function buildRouterTrainingPrompt() {
  const taxonomy = Object.entries(policy.taxonomy || {})
    .map(([kind, sports]) => `${kind}=[${sports.join(', ')}]`)
    .join('; ');
  const typos = Object.entries(policy.contextualTypos || {})
    .map(([meaning, forms]) => `${forms.join('/')}→${meaning}`)
    .join('; ');
  const flexibleAnswers = Object.entries(policy.flexibleAnswers || {})
    .map(([field, forms]) => `${field}=[${forms.join('; ')}]`)
    .join('; ');
  const examples = (policy.examples || []).map((example, index) => (
    `E${index + 1} ${JSON.stringify(example)}`
  )).join('\n');

  return [
    `TAXONOMY: ${taxonomy}`,
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
