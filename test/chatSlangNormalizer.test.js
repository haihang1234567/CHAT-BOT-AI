const test = require('node:test');
const assert = require('node:assert/strict');

const { expandChatSlang } = require('../src/chatSlangNormalizer');

const cases = [
  ['sp này còn sz 42 ko shop', 'sản phẩm này còn size 42 không shop'],
  ['mk muốn mua đôi giày chạy bộ tầm 1tr5', 'mình muốn mua đôi giày chạy bộ tầm 1tr5'],
  ['cho e xem vs ạ', 'cho em xem với ạ'],
  ['sao lâu ib z', 'sao lâu nhắn riêng vậy'],
  ['b tư vấn giúp mk ntn', 'bạn tư vấn giúp mình như thế nào'],
  ['đôi này bn shop', 'đôi này bao nhiêu shop'],
  ['còn sl 2 ko', 'còn số lượng 2 không'],
  ['ship về HN dc k', 'giao hàng về HN được không'],
  ['cho mk xin sdt', 'cho mình xin số điện thoại'],
  ['oder đôi này ntn', 'order đôi này như thế nào'],
  ['ad rep e vs', 'admin trả lời em với'],
  ['bh còn km j ko', 'bây giờ còn khuyến mãi gì không'],
  ['nv tv giúp m', 'nhân viên tư vấn giúp mình'],
  ['nt cho mk khi có hàng', 'nhắn tin cho mình khi có hàng'],
  ['tks shop, mk ch cần nữa', 'cảm ơn shop, mình chưa cần nữa'],
  ['SP001848 còn sz 42 ko', 'SP001848 còn size 42 không'],
  ['PR-241023 còn hàng ko', 'PR-241023 còn hàng không'],
  ['barcode 8938505974192 còn ko', 'barcode 8938505974192 còn không'],
  ['áo size M còn ko', 'áo size M còn không'],
  ['giày size B còn ko', 'giày size B còn không']
];

test('mở rộng teencode theo token chính xác và giữ nguyên dấu câu', () => {
  for (const [input, expected] of cases) {
    assert.equal(expandChatSlang(input), expected, input);
  }
});

test('không biến từ “sao” thành size và không sửa bên trong từ dài', () => {
  assert.equal(expandChatSlang('sao shop chưa rep'), 'sao shop chưa trả lời');
  assert.equal(expandChatSlang('mẫu kính không'), 'mẫu kính không');
});

test('phân biệt màu hồng với teencode hong theo ngữ cảnh', () => {
  assert.equal(expandChatSlang('màu hong mizuno'), 'màu hong mizuno');
  assert.equal(expandChatSlang('mau hong con hang hong'), 'mau hong con hang không');
  assert.equal(expandChatSlang('đôi này còn hàng hong'), 'đôi này còn hàng không');
});
