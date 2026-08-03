function normalize(value) {
  return String(value ?? '')
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function catalogProductKind(value) {
  const text = normalize(value);
  if (/(?:^|\s)giay(?:\s|$)/.test(text)) return 'shoe';
  if (/(?:^|\s)(?:quan ao|trang phuc)(?:\s|$)/.test(text)) return 'apparel';
  if (/(?:^|\s)(?:ao|polo|tee|jacket)(?:\s|$)/.test(text)) return 'shirt';
  if (/(?:^|\s)(?:quan|short)(?:\s|$)/.test(text)) return 'pants';
  if (/(?:^|\s)(?:tat|vo)(?:\s|$)/.test(text)) return 'socks';
  if (/(?:^|\s)(?:balo|ba lo|tui)(?:\s|$)/.test(text)) return 'bag';
  if (/(?:^|\s)(?:bao ho|ong dong|bang goi|bang co tay)(?:\s|$)/.test(text)) return 'protection';
  if (/(?:^|\s)(?:phu kien)(?:\s|$)/.test(text)) return 'accessory';
  if (/(?:^|\s)(?:dung cu|thiet bi)(?:\s|$)/.test(text)) return 'equipment';
  if (/(?:^|\s)vot(?:\s|$)/.test(text)) return 'racket';
  if (/(?:^|\s)(?:qua bong|trai bong|bong thi dau|bong)(?:\s|$)/.test(text)) return 'ball';
  return 'other';
}

function productKindMatches(actual, expected) {
  if (!expected) return true;
  if (expected === 'apparel') return ['apparel', 'shirt', 'pants'].includes(actual);
  return actual === expected;
}

function requiredProductKinds(requirements = []) {
  return [...new Set((Array.isArray(requirements) ? requirements : [])
    .filter((group) => normalize(group?.label).startsWith('loai san pham'))
    .map((group) => catalogProductKind([
      group?.label,
      ...(Array.isArray(group?.terms) ? group.terms : [])
    ].join(' ')))
    .filter((kind) => kind && kind !== 'other'))];
}

module.exports = {
  catalogProductKind,
  productKindMatches,
  requiredProductKinds
};
