const CHAT_SLANG = new Map([
  ['ko', 'không'],
  ['k', 'không'],
  ['hk', 'không'],
  ['hok', 'không'],
  ['hong', 'không'],
  ['khum', 'không'],
  ['dc', 'được'],
  ['đc', 'được'],
  ['dk', 'được'],
  ['đk', 'được'],
  ['mk', 'mình'],
  ['mik', 'mình'],
  ['m', 'mình'],
  ['b', 'bạn'],
  ['sp', 'sản phẩm'],
  ['sz', 'size'],
  ['sl', 'số lượng'],
  ['vs', 'với'],
  ['ib', 'nhắn riêng'],
  ['inb', 'nhắn riêng'],
  ['inbox', 'nhắn riêng'],
  ['add', 'thêm'],
  ['ntn', 'như thế nào'],
  ['bn', 'bao nhiêu'],
  ['bnhieu', 'bao nhiêu'],
  ['dt', 'điện thoại'],
  ['sdt', 'số điện thoại'],
  ['ship', 'giao hàng'],
  ['oder', 'order'],
  ['e', 'em'],
  ['j', 'gì'],
  ['z', 'vậy'],
  ['r', 'rồi'],
  ['cx', 'cũng'],
  ['ch', 'chưa'],
  ['nt', 'nhắn tin'],
  ['rep', 'trả lời'],
  ['ad', 'admin'],
  ['tks', 'cảm ơn'],
  ['thanks', 'cảm ơn'],
  ['mn', 'mọi người'],
  ['bh', 'bây giờ'],
  ['nv', 'nhân viên'],
  ['tv', 'tư vấn'],
  ['km', 'khuyến mãi'],
  ['đt', 'điện thoại']
]);

const TOKEN_PATTERN = /[\p{L}\p{N}._/-]+/gu;
const SIZE_CONTEXT = new Set(['size', 'sz', 'cỡ', 'co']);
const COLOR_CONTEXT = new Set(['màu', 'mau', 'color']);

function foldForCatalog(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .toLowerCase();
}

const SLANG_EXPANSION_TOKENS = new Set(
  [...CHAT_SLANG.values()]
    .flatMap((value) => foldForCatalog(value).split(/\s+/))
    .filter(Boolean)
);

function expandChatSlang(rawMessage) {
  const source = String(rawMessage ?? '');
  const matches = [...source.matchAll(TOKEN_PATTERN)];
  if (!matches.length) return source;

  let cursor = 0;
  let output = '';
  let previousToken = '';

  for (const match of matches) {
    const token = match[0];
    const index = match.index || 0;
    const lookup = token.toLocaleLowerCase('vi');
    let replacement = token;

    // Không sửa mã sản phẩm, SKU, barcode hoặc giá trị size chữ.
    const looksLikeCode = /\d|[._/-]/.test(token);
    const isSizeValue = lookup.length === 1 && SIZE_CONTEXT.has(previousToken);
    const isColorValue = lookup === 'hong' && COLOR_CONTEXT.has(previousToken);
    if (!looksLikeCode && !isSizeValue && !isColorValue && CHAT_SLANG.has(lookup)) {
      replacement = CHAT_SLANG.get(lookup);
    }

    output += source.slice(cursor, index);
    output += replacement;
    cursor = index + token.length;
    previousToken = lookup;
  }

  return output + source.slice(cursor);
}

module.exports = {
  CHAT_SLANG,
  SLANG_EXPANSION_TOKENS,
  expandChatSlang
};
