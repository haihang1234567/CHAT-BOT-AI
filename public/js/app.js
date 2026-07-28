(() => {
  'use strict';

  const PLACEHOLDER_IMAGE = 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" width="640" height="480">
      <rect width="100%" height="100%" fill="#f0f4f2"/>
      <text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="#7b8983" font-family="Arial" font-size="28">Đang cập nhật ảnh</text>
    </svg>
  `);

  const els = {
    messages: document.getElementById('chatMessages'),
    form: document.getElementById('chatForm'),
    input: document.getElementById('messageInput'),
    send: document.getElementById('sendButton'),
    cartButton: document.getElementById('cartButton'),
    cartPanel: document.getElementById('cartPanel'),
    closeCart: document.getElementById('closeCartButton'),
    overlay: document.getElementById('overlay'),
    cartCount: document.getElementById('cartCount'),
    cartItems: document.getElementById('cartItems'),
    cartTotal: document.getElementById('cartTotal'),
    checkoutButton: document.getElementById('checkoutButton'),
    variantDialog: document.getElementById('variantDialog'),
    variantProductName: document.getElementById('variantProductName'),
    variantImage: document.getElementById('variantImage'),
    variantSelect: document.getElementById('variantSelect'),
    variantQuantity: document.getElementById('variantQuantity'),
    variantPrice: document.getElementById('variantPrice'),
    confirmVariant: document.getElementById('confirmVariantButton'),
    checkoutDialog: document.getElementById('checkoutDialog'),
    checkoutForm: document.getElementById('checkoutForm'),
    checkoutTotal: document.getElementById('checkoutTotal'),
    checkoutError: document.getElementById('checkoutError'),
    closeCheckout: document.getElementById('closeCheckoutButton'),
    submitOrder: document.getElementById('submitOrderButton'),
    toast: document.getElementById('toast')
  };

  const state = {
    sessionId: localStorage.getItem('ghsSessionId') || crypto.randomUUID(),
    cart: JSON.parse(localStorage.getItem('ghsCart') || '[]'),
    activeProduct: null,
    seenMessageIds: new Set(),
    typingNode: null,
    events: null
  };
  localStorage.setItem('ghsSessionId', state.sessionId);

  function formatMoney(value) {
    return new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND', maximumFractionDigits: 0 }).format(Number(value || 0));
  }

  function priceRange(min, max) {
    if (!min && !max) return 'Liên hệ';
    if (!max || min === max) return formatMoney(min || max);
    return `${formatMoney(min)} – ${formatMoney(max)}`;
  }

  function create(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function showToast(text) {
    els.toast.textContent = text;
    els.toast.classList.add('show');
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => els.toast.classList.remove('show'), 2800);
  }

  function safeImage(img, src) {
    img.src = /^https?:\/\//i.test(src || '') || String(src || '').startsWith('data:') ? src : PLACEHOLDER_IMAGE;
    img.addEventListener('error', () => { img.src = PLACEHOLDER_IMAGE; }, { once: true });
  }

  function scrollToBottom() {
    requestAnimationFrame(() => { els.messages.scrollTop = els.messages.scrollHeight; });
  }

  function roleLabel(role) {
    if (role === 'user') return 'Bạn';
    if (role === 'admin') return 'Nhân viên GHS';
    return 'Trợ lý GHS';
  }

  function addMessage(role, text, options = {}) {
    if (options.id && state.seenMessageIds.has(options.id)) return null;
    if (options.id) state.seenMessageIds.add(options.id);

    const row = create('div', `message-row ${role}`);
    const avatar = create('div', 'avatar', role === 'user' ? '👤' : role === 'admin' ? '🧑‍💼' : 'G');
    const stack = create('div', 'message-stack');
    const meta = create('div', 'message-meta', roleLabel(role));
    const bubble = create('div', 'message-bubble', text);
    stack.append(meta, bubble);

    if (Array.isArray(options.products) && options.products.length) {
      stack.appendChild(renderProductGrid(options.products));
    }

    row.append(avatar, stack);
    els.messages.appendChild(row);
    scrollToBottom();
    return row;
  }

  function showTyping() {
    hideTyping();
    const row = create('div', 'message-row assistant typing');
    const avatar = create('div', 'avatar', 'G');
    const stack = create('div', 'message-stack');
    stack.appendChild(create('div', 'message-meta', 'Trợ lý GHS đang trả lời'));
    const bubble = create('div', 'message-bubble');
    for (let i = 0; i < 3; i += 1) bubble.appendChild(create('span', 'typing-dot'));
    stack.appendChild(bubble);
    row.append(avatar, stack);
    els.messages.appendChild(row);
    state.typingNode = row;
    scrollToBottom();
  }

  function hideTyping() {
    if (state.typingNode) state.typingNode.remove();
    state.typingNode = null;
  }

  function salePercent(product) {
    const saleVariants = (product.variants || []).filter((v) => v.price > 0 && v.compareAtPrice > v.price);
    if (!saleVariants.length) return 0;
    return Math.max(...saleVariants.map((v) => Math.round((1 - v.price / v.compareAtPrice) * 100)));
  }

  function renderProductGrid(products) {
    const grid = create('div', 'product-grid');
    for (const product of products) grid.appendChild(renderProductCard(product));
    return grid;
  }

  function renderProductCard(product) {
    const card = create('article', 'product-card');
    const imageWrap = create('div', 'product-image-wrap');
    const image = create('img', 'product-image');
    image.alt = product.name;
    image.loading = 'lazy';
    safeImage(image, product.images?.[0] || product.variants?.find((v) => v.image)?.image || PLACEHOLDER_IMAGE);
    imageWrap.appendChild(image);

    const stock = create('span', `stock-pill${product.inStock ? '' : ' out'}`, product.inStock ? 'Còn hàng' : 'Hết hàng');
    imageWrap.appendChild(stock);
    const percent = salePercent(product);
    if (percent) imageWrap.appendChild(create('span', 'sale-pill', `-${percent}%`));

    const body = create('div', 'product-body');
    body.appendChild(create('p', 'product-brand', [product.brand, product.type].filter(Boolean).join(' · ') || 'GHS SPORT'));
    body.appendChild(create('h3', 'product-title', product.name));
    body.appendChild(create('p', 'product-code', `Mã sản phẩm: ${product.id}`));

    const price = create('div', 'price-row');
    const currentPrice = create('span', product.hasSale ? 'sale-price' : 'regular-price', priceRange(product.priceMin, product.priceMax));
    price.appendChild(currentPrice);
    if (product.hasSale && product.compareAtMax > 0) {
      price.appendChild(create('span', 'original-price', priceRange(product.compareAtMin, product.compareAtMax)));
    }
    body.appendChild(price);

    const attrs = create('div', 'product-attributes');
    const colorLine = create('div');
    colorLine.append(create('strong', '', 'Màu: '), document.createTextNode(product.colors?.join(', ') || 'Đang cập nhật'));
    const sizeLine = create('div');
    sizeLine.append(create('strong', '', 'Size: '), document.createTextNode(product.sizes?.join(', ') || 'Mặc định'));
    attrs.append(colorLine, sizeLine);
    body.appendChild(attrs);

    const actions = create('div', 'product-actions');
    const detail = create('a', '', 'Xem chi tiết');
    detail.href = product.url;
    detail.target = '_blank';
    detail.rel = 'noopener noreferrer';
    const buy = create('button', '', 'Chọn mua');
    buy.type = 'button';
    buy.disabled = !product.inStock;
    buy.addEventListener('click', () => openVariantDialog(product));
    actions.append(detail, buy);
    body.appendChild(actions);

    card.append(imageWrap, body);
    return card;
  }

  function variantLabel(variant) {
    const attributes = [variant.color, variant.size ? `Size ${variant.size}` : ''].filter(Boolean).join(' · ');
    return `${attributes || variant.sku || variant.id} · ${variant.inStock ? 'Còn hàng' : 'Hết hàng'} · ${formatMoney(variant.price)}`;
  }

  function openVariantDialog(product) {
    state.activeProduct = product;
    els.variantProductName.textContent = product.name;
    els.variantSelect.textContent = '';

    const variants = [...(product.variants || [])].sort((a, b) => Number(b.inStock) - Number(a.inStock));
    for (const variant of variants) {
      const option = document.createElement('option');
      option.value = variant.id;
      option.textContent = variantLabel(variant);
      option.disabled = !variant.inStock;
      els.variantSelect.appendChild(option);
    }

    const preferred = variants.find((variant) => variant.id === product.matchedVariantId && variant.inStock)
      || variants.find((variant) => variant.inStock);
    if (!preferred) {
      showToast('Sản phẩm hiện đã hết hàng.');
      return;
    }
    els.variantSelect.value = preferred.id;
    els.variantQuantity.value = '1';
    updateVariantPreview();
    els.variantDialog.showModal();
  }

  function selectedVariant() {
    return state.activeProduct?.variants?.find((variant) => variant.id === els.variantSelect.value) || null;
  }

  function updateVariantPreview() {
    const variant = selectedVariant();
    if (!variant) return;
    safeImage(els.variantImage, variant.image || state.activeProduct.images?.[0] || PLACEHOLDER_IMAGE);
    els.variantPrice.textContent = variant.compareAtPrice > variant.price
      ? `${formatMoney(variant.price)} (Giá gốc ${formatMoney(variant.compareAtPrice)})`
      : formatMoney(variant.price);
  }

  function saveCart() {
    localStorage.setItem('ghsCart', JSON.stringify(state.cart));
    renderCart();
  }

  function addSelectedVariantToCart() {
    const variant = selectedVariant();
    const quantity = Math.max(1, Math.min(99, Number(els.variantQuantity.value || 1)));
    if (!variant || !variant.inStock) return showToast('Biến thể này hiện hết hàng.');

    const existing = state.cart.find((item) => item.variantId === variant.id);
    if (existing) existing.quantity = Math.min(99, existing.quantity + quantity);
    else {
      state.cart.push({
        productId: state.activeProduct.id,
        variantId: variant.id,
        sku: variant.sku,
        name: state.activeProduct.name,
        color: variant.color,
        size: variant.size,
        price: variant.price,
        image: variant.image || state.activeProduct.images?.[0] || '',
        url: state.activeProduct.url,
        quantity
      });
    }
    saveCart();
    els.variantDialog.close();
    showToast('Đã thêm sản phẩm vào đơn nháp.');
    if (window.innerWidth <= 980) openCart();
  }

  function cartTotal() {
    return state.cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
  }

  function renderCart() {
    els.cartItems.textContent = '';
    const totalQuantity = state.cart.reduce((sum, item) => sum + item.quantity, 0);
    els.cartCount.textContent = String(totalQuantity);
    els.cartTotal.textContent = formatMoney(cartTotal());
    els.checkoutTotal.textContent = formatMoney(cartTotal());
    els.checkoutButton.disabled = !state.cart.length;

    if (!state.cart.length) {
      const empty = create('div', 'empty-cart');
      const inner = create('div');
      inner.append(create('div', 'empty-icon', '🛒'), create('p', '', 'Chưa có sản phẩm nào trong đơn nháp.'));
      empty.appendChild(inner);
      els.cartItems.appendChild(empty);
      return;
    }

    state.cart.forEach((item, index) => {
      const row = create('article', 'cart-item');
      const image = create('img');
      image.alt = item.name;
      safeImage(image, item.image || PLACEHOLDER_IMAGE);
      const info = create('div');
      info.appendChild(create('h3', '', item.name));
      info.appendChild(create('p', '', [item.color, item.size ? `Size ${item.size}` : '', item.sku].filter(Boolean).join(' · ')));
      const qty = create('div', 'quantity-row');
      const minus = create('button', '', '−');
      minus.type = 'button';
      minus.addEventListener('click', () => {
        item.quantity -= 1;
        if (item.quantity <= 0) state.cart.splice(index, 1);
        saveCart();
      });
      const amount = create('span', '', String(item.quantity));
      const plus = create('button', '', '+');
      plus.type = 'button';
      plus.addEventListener('click', () => { item.quantity = Math.min(99, item.quantity + 1); saveCart(); });
      const remove = create('button', 'remove-link', 'Xóa');
      remove.type = 'button';
      remove.addEventListener('click', () => { state.cart.splice(index, 1); saveCart(); });
      qty.append(minus, amount, plus, remove);
      info.appendChild(qty);
      const price = create('div', 'cart-item-price', formatMoney(item.price * item.quantity));
      row.append(image, info, price);
      els.cartItems.appendChild(row);
    });
  }

  function openCart() {
    els.cartPanel.classList.add('open');
    els.overlay.hidden = false;
  }

  function closeCart() {
    els.cartPanel.classList.remove('open');
    els.overlay.hidden = true;
  }

  async function submitOrder(event) {
    event.preventDefault();
    els.checkoutError.textContent = '';
    els.submitOrder.disabled = true;
    const data = new FormData(els.checkoutForm);
    try {
      const response = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: state.sessionId,
          customer: {
            name: data.get('name'),
            phone: data.get('phone'),
            address: data.get('address'),
            note: data.get('note')
          },
          items: state.cart.map((item) => ({ variantId: item.variantId, quantity: item.quantity }))
        })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Không lưu được đơn.');
      state.cart = [];
      saveCart();
      els.checkoutForm.reset();
      els.checkoutDialog.close();
      closeCart();
      showToast(`Đã lưu đơn ${result.order.id}.`);
    } catch (error) {
      els.checkoutError.textContent = error.message;
    } finally {
      els.submitOrder.disabled = false;
    }
  }

  async function restoreSession() {
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(state.sessionId)}`);
      const { session } = await response.json();
      if (!session?.messages?.length) {
        addMessage('assistant', 'Xin chào! Mình là trợ lý Green Holding Sport. Bạn có thể nhập tên, mã sản phẩm, SKU, barcode hoặc mô tả nhu cầu để mình tìm và tư vấn.');
        return;
      }

      for (const message of session.messages) {
        let productCards = [];
        if (Array.isArray(message.productIds) && message.productIds.length) {
          const loaded = await Promise.all(message.productIds.map(async (id) => {
            try {
              const res = await fetch(`/api/products/${encodeURIComponent(id)}`);
              return res.ok ? (await res.json()).product : null;
            } catch (_) { return null; }
          }));
          productCards = loaded.filter(Boolean);
        }
        addMessage(message.role, message.text, { id: message.id, products: productCards });
      }
    } catch (_) {
      addMessage('assistant', 'Xin chào! Mình sẵn sàng hỗ trợ tìm và tư vấn sản phẩm Green Holding Sport.');
    }
  }

  async function sendMessage(text) {
    const message = String(text || '').trim();
    if (!message) return;
    addMessage('user', message);
    els.input.value = '';
    autoResize();
    els.send.disabled = true;
    showTyping();

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: state.sessionId, message })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Không gửi được tin nhắn.');
      hideTyping();
      if (result.reply && !state.seenMessageIds.has(result.messageId)) {
        addMessage('assistant', result.reply, { id: result.messageId, products: result.products || [] });
      } else if (!result.reply && ['human', 'waiting_admin'].includes(result.sessionStatus)) {
        showToast('Tin nhắn đã gửi đến nhân viên.');
      }
    } catch (error) {
      hideTyping();
      addMessage('assistant', `Có lỗi kết nối: ${error.message}. Bạn có thể thử lại hoặc gõ “admin”.`);
    } finally {
      els.send.disabled = false;
      els.input.focus();
    }
  }

  function autoResize() {
    els.input.style.height = 'auto';
    els.input.style.height = `${Math.min(els.input.scrollHeight, 140)}px`;
  }

  function connectEvents() {
    if (state.events) state.events.close();
    state.events = new EventSource(`/api/events/customer?sessionId=${encodeURIComponent(state.sessionId)}`);
    state.events.addEventListener('chat-message', (event) => {
      const message = JSON.parse(event.data);
      hideTyping();
      addMessage(message.role, message.text, { id: message.id, products: message.products || [] });
    });
  }

  els.form.addEventListener('submit', (event) => {
    event.preventDefault();
    sendMessage(els.input.value);
  });
  els.input.addEventListener('input', autoResize);
  els.input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      els.form.requestSubmit();
    }
  });
  document.querySelectorAll('[data-prompt]').forEach((button) => {
    button.addEventListener('click', () => sendMessage(button.dataset.prompt));
  });
  els.cartButton.addEventListener('click', openCart);
  els.closeCart.addEventListener('click', closeCart);
  els.overlay.addEventListener('click', closeCart);
  els.variantSelect.addEventListener('change', updateVariantPreview);
  els.confirmVariant.addEventListener('click', addSelectedVariantToCart);
  els.checkoutButton.addEventListener('click', () => {
    els.checkoutTotal.textContent = formatMoney(cartTotal());
    els.checkoutError.textContent = '';
    els.checkoutDialog.showModal();
  });
  els.closeCheckout.addEventListener('click', () => els.checkoutDialog.close());
  els.checkoutForm.addEventListener('submit', submitOrder);

  renderCart();
  restoreSession();
  connectEvents();
})();
