const { normalizeText } = require('./productService');

function formatMoney(value) {
  const amount = Number(value || 0);
  return amount > 0 ? `${Math.round(amount).toLocaleString('vi-VN')}đ` : 'Đang cập nhật';
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

class LocalChatEngine {
  constructor(productService) {
    this.products = productService;
  }

  contextProducts(history = [], limit = 5) {
    const ids = [];
    const seen = new Set();
    for (const message of [...history].reverse()) {
      for (const id of message.productIds || []) {
        const key = String(id);
        if (!seen.has(key)) {
          seen.add(key);
          ids.push(key);
        }
        if (ids.length >= limit) break;
      }
      if (ids.length >= limit) break;
    }
    return ids.map((id) => this.products.getProduct(id)).filter(Boolean);
  }

  isContextReference(normalized) {
    return /\b(mau nay|san pham nay|doi nay|no|cai nay|mau tren|san pham tren|doi tren|mau vua roi)\b/.test(normalized);
  }

  flags(message) {
    const q = normalizeText(message);
    return {
      normalized: q,
      greeting: /^(xin chao|chao|hello|hi|alo|shop oi|ad oi)[!. ]*$/.test(q),
      thanks: /^(cam on|thank|thanks|ok cam on|duoc roi cam on)[!. ]*$/.test(q),
      asksPrice: /\b(gia|bao nhieu tien|khuyen mai|giam gia|gia goc|gia ban)\b/.test(q),
      asksColor: /\b(mau|mau sac)\b/.test(q),
      asksSize: /\b(size|kich thuoc|sz|so size)\b/.test(q),
      asksStock: /\b(con hang|het hang|ton kho|co hang khong)\b/.test(q),
      asksLink: /\b(link|duong dan|website|web|xem chi tiet|trang san pham)\b/.test(q),
      asksImage: /\b(anh|hinh|hinh anh)\b/.test(q),
      asksCode: /\b(ma san pham|ma bien the|sku|barcode|ma hang)\b/.test(q),
      asksDescription: /\b(mo ta|chi tiet|thong tin chi tiet|tinh nang|cong nghe|chat lieu|dac diem)\b/.test(q),
      asksAdvice: /\b(tu van|nen chon|phu hop|so sanh|khac nhau|tot hon|uu diem|nhuoc diem|danh gia|goi y|chon giup|dung cho|choi san|co tot khong|tai sao)\b/.test(q)
    };
  }

  lookupQuery(message) {
    const normalized = normalizeText(message);
    const cleaned = normalized
      .replace(/\b(gia bao nhieu|bao nhieu tien|co mau gi|mau gi|co size nao|size nao|con hang khong|co hang khong|xem chi tiet|duong dan|trang san pham|tu van|goi y|chon giup|mo ta chi tiet|thong tin chi tiet)\b/g, ' ')
      .replace(/\b(cho toi|giup toi|shop oi|ad oi|xin hoi|toi can|toi muon|tim giup)\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return cleaned || normalized;
  }

  resolveCandidates(message, history = []) {
    const exact = this.products.exactLookup(message);
    if (exact) {
      return {
        exact,
        candidates: [this.products.publicProduct(exact.product, exact.variant)]
      };
    }

    const flags = this.flags(message);
    const lookup = this.lookupQuery(message);
    let candidates = this.products.search(lookup, 6);

    const genericTokens = new Set([
      'giay', 'ao', 'quan', 'vot', 'bong', 'chuyen', 'da', 'cau', 'long',
      'mizuno', 'jogarbola', 'promax', 'mitre', 'joma', 'zocker',
      'tam', 'khoang', 'trieu', 'nghin', 'size', 'mau'
    ]);
    const modelTokens = normalizeText(lookup)
      .split(' ')
      .filter((token) => token.length > 2 && !genericTokens.has(token) && !/^\d+(?:\.\d+)?$/.test(token));
    if (modelTokens.length >= 2) {
      const strictMatches = candidates.filter((product) => {
        const name = normalizeText(product.name);
        return modelTokens.every((token) => name.includes(token));
      });
      if (strictMatches.length) candidates = strictMatches;
    }

    if (this.isContextReference(flags.normalized)) {
      const contextual = this.contextProducts(history, 5);
      if (contextual.length) candidates = contextual;
    }
    return { exact: null, candidates };
  }

  priceText(product, matchedVariant = null) {
    const variant = matchedVariant || (product.matchedVariantId
      ? product.variants.find((item) => item.id === product.matchedVariantId)
      : null);

    if (variant) {
      if (variant.compareAtPrice > variant.price && variant.price > 0) {
        return `giá gốc ${formatMoney(variant.compareAtPrice)}, hiện còn ${formatMoney(variant.price)}`;
      }
      return `giá ${formatMoney(variant.price)}`;
    }

    const price = product.priceMin === product.priceMax
      ? formatMoney(product.priceMin)
      : `${formatMoney(product.priceMin)} – ${formatMoney(product.priceMax)}`;
    if (product.hasSale && product.compareAtMax > product.priceMin) {
      const original = product.compareAtMin === product.compareAtMax
        ? formatMoney(product.compareAtMin)
        : `${formatMoney(product.compareAtMin)} – ${formatMoney(product.compareAtMax)}`;
      return `giá gốc ${original}, giá hiện tại ${price}`;
    }
    return `giá ${price}`;
  }

  variantFromProduct(product) {
    if (!product?.matchedVariantId) return null;
    return product.variants.find((item) => item.id === product.matchedVariantId) || null;
  }

  singleProductReply(product, flags, exact = null) {
    const matchedVariant = exact?.variant || this.variantFromProduct(product);
    const details = [];

    if (flags.asksPrice) details.push(this.priceText(product, matchedVariant));
    if (flags.asksColor) {
      const colors = matchedVariant?.color ? [matchedVariant.color] : unique(product.colors);
      details.push(colors.length ? `màu: ${colors.join(', ')}` : 'màu sắc đang cập nhật');
    }
    if (flags.asksSize) {
      const sizes = matchedVariant?.size ? [matchedVariant.size] : unique(product.sizes);
      details.push(sizes.length ? `size: ${sizes.join(', ')}` : 'size đang cập nhật');
    }
    if (flags.asksStock) {
      const inStock = matchedVariant ? matchedVariant.inStock : product.inStock;
      details.push(inStock ? 'tình trạng: Còn hàng' : 'tình trạng: Hết hàng');
    }
    if (flags.asksCode) {
      if (matchedVariant) {
        const codes = [
          `mã sản phẩm ${product.id}`,
          matchedVariant.id ? `mã biến thể ${matchedVariant.id}` : '',
          matchedVariant.sku ? `SKU ${matchedVariant.sku}` : '',
          matchedVariant.barcode ? `barcode ${matchedVariant.barcode}` : ''
        ].filter(Boolean);
        details.push(codes.join(', '));
      } else {
        details.push(`mã sản phẩm ${product.id}`);
      }
    }
    if (flags.asksLink) details.push(`đường dẫn chi tiết nằm ở nút “Xem chi tiết” bên dưới`);
    if (flags.asksImage) details.push('hình ảnh sản phẩm được hiển thị trong thẻ bên dưới');

    if (!details.length) {
      const variantText = matchedVariant
        ? `${matchedVariant.color ? `, màu ${matchedVariant.color}` : ''}${matchedVariant.size ? `, size ${matchedVariant.size}` : ''}`
        : '';
      return `Mình đã tìm thấy “${product.name}”${variantText}. Bạn xem ảnh, giá, màu, size và link sản phẩm ở thẻ bên dưới nhé.`;
    }

    return `“${product.name}” có ${details.join('; ')}. Bạn có thể xem đầy đủ và chọn biến thể ở thẻ sản phẩm bên dưới.`;
  }

  multipleProductsReply(candidates, flags) {
    const count = Math.min(candidates.length, 5);
    if (flags.asksPrice) {
      return `Mình đã lọc được ${count} sản phẩm phù hợp. Giá và giá khuyến mãi của từng mẫu được hiển thị trực tiếp trên các thẻ bên dưới.`;
    }
    if (flags.asksColor || flags.asksSize || flags.asksStock) {
      return `Mình đã tìm thấy ${count} sản phẩm gần với yêu cầu. Màu, size và trạng thái Còn hàng/Hết hàng được hiển thị trên từng thẻ.`;
    }
    return `Mình đã tìm thấy ${count} sản phẩm gần với nhu cầu của bạn. Bạn xem ảnh, giá, màu, size và mở trang chi tiết ngay trên các thẻ bên dưới nhé.`;
  }

  analyze(message, history = []) {
    const flags = this.flags(message);

    if (flags.greeting) {
      return {
        useAi: false,
        reply: 'Chào bạn! Bạn có thể nhập tên sản phẩm, mã sản phẩm, SKU, barcode hoặc mô tả nhu cầu để mình tìm giúp. Cần gặp nhân viên, hãy gõ “admin”.',
        products: [],
        candidates: [],
        reason: 'greeting'
      };
    }

    if (flags.thanks) {
      return {
        useAi: false,
        reply: 'Rất vui được hỗ trợ bạn. Khi cần tìm thêm sản phẩm, bạn chỉ cần gửi tên, mã, size, màu hoặc mức giá mong muốn nhé.',
        products: [],
        candidates: [],
        reason: 'thanks'
      };
    }

    const { exact, candidates } = this.resolveCandidates(message, history);

    // Mã chính xác luôn được xử lý hoàn toàn bằng code, không tốn token AI.
    if (exact) {
      const product = candidates[0];
      return {
        useAi: false,
        reply: this.singleProductReply(product, flags, exact),
        products: [product],
        candidates: [product],
        reason: 'exact-code'
      };
    }

    if (!candidates.length) {
      return {
        useAi: false,
        reply: 'Mình chưa tìm thấy sản phẩm phù hợp trong dữ liệu hiện tại. Bạn hãy gửi rõ hơn tên, mã sản phẩm, SKU, barcode, môn thể thao, size hoặc mức giá. Cần hỗ trợ trực tiếp, hãy gõ “admin”.',
        products: [],
        candidates: [],
        reason: 'no-candidate'
      };
    }

    const factualOnly = flags.asksPrice || flags.asksColor || flags.asksSize || flags.asksStock
      || flags.asksLink || flags.asksImage || flags.asksCode;
    const needsAi = flags.asksAdvice || flags.asksDescription;

    // Các câu hỏi dữ liệu cấu trúc được code trả lời trực tiếp.
    if (factualOnly && !needsAi) {
      return {
        useAi: false,
        reply: candidates.length === 1
          ? this.singleProductReply(candidates[0], flags)
          : this.multipleProductsReply(candidates, flags),
        products: candidates.slice(0, 5),
        candidates,
        reason: 'structured-facts'
      };
    }

    // Tìm kiếm thông thường cũng không cần AI.
    if (!needsAi) {
      return {
        useAi: false,
        reply: candidates.length === 1
          ? this.singleProductReply(candidates[0], flags)
          : this.multipleProductsReply(candidates, flags),
        products: candidates.slice(0, 5),
        candidates,
        reason: 'local-search'
      };
    }

    // Chỉ tư vấn, so sánh, giải thích mô tả/công nghệ mới chuyển sang AI.
    return {
      useAi: true,
      reply: '',
      products: candidates.slice(0, 5),
      candidates: candidates.slice(0, 3),
      reason: flags.asksDescription ? 'description' : 'advice'
    };
  }
}

module.exports = LocalChatEngine;
