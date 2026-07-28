(() => {
  'use strict';

  const PLACEHOLDER_IMAGE = 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="100%" height="100%" fill="#f0f4f2"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="#7b8983" font-family="Arial" font-size="16">Không có ảnh</text></svg>
  `);

  const els = {
    login: document.getElementById('adminLogin'),
    loginForm: document.getElementById('loginForm'),
    password: document.getElementById('adminPassword'),
    adminName: document.getElementById('adminName'),
    loginError: document.getElementById('loginError'),
    app: document.getElementById('adminApp'),
    systemStatus: document.getElementById('systemStatus'),
    testAi: document.getElementById('testAiButton'),
    logout: document.getElementById('logoutButton'),
    tabs: document.querySelectorAll('[data-tab]'),
    chatsTab: document.getElementById('chatsTab'),
    ordersTab: document.getElementById('ordersTab'),
    waitingBadge: document.getElementById('waitingBadge'),
    orderBadge: document.getElementById('orderBadge'),
    refreshSessions: document.getElementById('refreshSessions'),
    filters: document.querySelectorAll('[data-filter]'),
    sessionList: document.getElementById('sessionList'),
    emptyConversation: document.getElementById('emptyConversation'),
    conversationView: document.getElementById('conversationView'),
    activeSessionId: document.getElementById('activeSessionId'),
    activeSessionStatus: document.getElementById('activeSessionStatus'),
    claim: document.getElementById('claimButton'),
    release: document.getElementById('releaseButton'),
    messages: document.getElementById('adminMessages'),
    messageForm: document.getElementById('adminMessageForm'),
    messageInput: document.getElementById('adminMessageInput'),
    refreshOrders: document.getElementById('refreshOrders'),
    ordersList: document.getElementById('ordersList'),
    toast: document.getElementById('adminToast')
  };

  const state = {
    token: sessionStorage.getItem('ghsAdminToken') || '',
    adminName: sessionStorage.getItem('ghsAdminName') || 'Nhân viên GHS',
    sessions: [],
    activeSession: null,
    activeSessionId: '',
    loadingSessionId: '',
    filter: 'all',
    events: null,
    seenMessageIds: new Set()
  };

  function create(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function setVisible(node, visible, displayValue = '') {
    if (!node) return;
    node.hidden = !visible;
    node.style.display = visible ? displayValue : 'none';
  }

  function formatMoney(value) {
    return new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND', maximumFractionDigits: 0 }).format(Number(value || 0));
  }

  function formatTime(value) {
    if (!value) return '';
    return new Intl.DateTimeFormat('vi-VN', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value));
  }

  function shortId(id) {
    return String(id || '').slice(0, 8).toUpperCase();
  }

  function showToast(text) {
    els.toast.textContent = text;
    els.toast.classList.add('show');
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => els.toast.classList.remove('show'), 3500);
  }

  function headers() {
    return { 'Content-Type': 'application/json', 'X-Admin-Token': state.token };
  }

  async function api(url, options = {}) {
    const response = await fetch(url, {
      cache: 'no-store',
      ...options,
      headers: { ...headers(), ...(options.headers || {}) }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) {
        sessionStorage.removeItem('ghsAdminToken');
      }
      throw new Error(data.message || data.error || `Lỗi ${response.status}`);
    }
    return data;
  }

  function statusLabel(status) {
    return ({ bot: 'AI đang tư vấn', waiting_admin: 'Đang chờ nhân viên', human: 'Nhân viên đang hỗ trợ' })[status] || status;
  }

  async function login(password, adminName) {
    const response = await fetch('/api/admin/login', {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || 'Không đăng nhập được.');

    state.token = result.token;
    state.adminName = adminName;
    sessionStorage.setItem('ghsAdminToken', result.token);
    sessionStorage.setItem('ghsAdminName', adminName);
    setVisible(els.login, false);
    setVisible(els.app, true);
    connectEvents();
    await Promise.all([loadHealth(), loadSessions(), loadOrders()]);
  }

  async function loadHealth() {
    try {
      const response = await fetch('/api/health', { cache: 'no-store' });
      const health = await response.json();
      els.systemStatus.textContent = `${health.productCount} sản phẩm · AI ${health.aiConfigured ? 'đã cấu hình' : 'chưa cấu hình'}`;
    } catch (_) {
      els.systemStatus.textContent = 'Không đọc được trạng thái hệ thống';
    }
  }

  async function loadSessions() {
    try {
      const { sessions } = await api('/api/admin/sessions');
      state.sessions = sessions;
      renderSessions();
    } catch (error) {
      showToast(error.message);
    }
  }

  function renderSessions() {
    const filtered = state.filter === 'all'
      ? state.sessions
      : state.sessions.filter((item) => item.status === state.filter);

    els.sessionList.textContent = '';
    els.waitingBadge.textContent = String(state.sessions.filter((item) => item.status === 'waiting_admin').length);

    if (!filtered.length) {
      const empty = create('div', 'empty-state');
      empty.appendChild(create('p', '', 'Chưa có cuộc trò chuyện phù hợp.'));
      els.sessionList.appendChild(empty);
      return;
    }

    for (const session of filtered) {
      const isActive = state.activeSessionId === session.id;
      const isLoading = state.loadingSessionId === session.id;
      const button = create('button', `session-card${isActive ? ' active' : ''}${isLoading ? ' loading' : ''}`);
      button.type = 'button';
      button.dataset.sessionId = session.id;
      button.setAttribute('aria-label', `Mở cuộc trò chuyện của khách ${shortId(session.id)}`);
      button.setAttribute('aria-pressed', isActive ? 'true' : 'false');

      const top = create('div', 'session-card-top');
      top.append(create('strong', '', `Khách ${shortId(session.id)}`), create('time', '', formatTime(session.updatedAt)));
      const last = session.lastMessage?.text || 'Chưa có tin nhắn';
      button.append(top, create('p', '', isLoading ? 'Đang tải cuộc trò chuyện...' : last), create('span', `status-chip ${session.status}`, statusLabel(session.status)));
      els.sessionList.appendChild(button);
    }
  }

  function showConversationLoading(sessionId) {
    setVisible(els.emptyConversation, false);
    setVisible(els.conversationView, true, 'flex');
    els.activeSessionId.textContent = sessionId;
    els.activeSessionStatus.textContent = 'Đang tải nội dung cuộc trò chuyện...';
    els.messages.textContent = '';
    const loading = create('div', 'conversation-loading', 'Đang tải tin nhắn...');
    els.messages.appendChild(loading);
    els.claim.disabled = true;
    els.release.disabled = true;
    els.messageInput.disabled = true;
  }

  async function openSession(sessionId) {
    if (!sessionId || state.loadingSessionId) return;

    state.activeSessionId = sessionId;
    state.loadingSessionId = sessionId;
    renderSessions();
    showConversationLoading(sessionId);

    try {
      // Endpoint query-string tránh lỗi mã phiên có ký tự đặc biệt và dễ debug hơn.
      const { session } = await api(`/api/admin/session?sessionId=${encodeURIComponent(sessionId)}`);
      state.activeSession = session;
      state.activeSessionId = session.id;
      state.seenMessageIds = new Set();
      renderConversation();
    } catch (error) {
      state.activeSession = null;
      setVisible(els.emptyConversation, false);
      setVisible(els.conversationView, true, 'flex');
      els.activeSessionId.textContent = `Khách ${shortId(sessionId)}`;
      els.activeSessionStatus.textContent = 'Không tải được cuộc trò chuyện';
      els.messages.textContent = '';
      const errorBox = create('div', 'conversation-error');
      errorBox.append(create('strong', '', 'Không mở được nội dung.'), create('p', '', error.message));
      els.messages.appendChild(errorBox);
      showToast(`Không mở được cuộc trò chuyện: ${error.message}`);
    } finally {
      state.loadingSessionId = '';
      renderSessions();
    }
  }

  function roleLabel(role) {
    if (role === 'user') return 'Khách hàng';
    if (role === 'admin') return 'Nhân viên GHS';
    return 'Trợ lý AI';
  }

  function appendMessage(message) {
    if (!message || state.seenMessageIds.has(message.id)) return;
    state.seenMessageIds.add(message.id);
    const role = message.role === 'assistant' ? 'assistant' : message.role;
    const row = create('div', `message-row ${role}`);
    const avatar = create('div', 'avatar', role === 'user' ? '👤' : role === 'admin' ? '🧑‍💼' : 'G');
    const stack = create('div', 'message-stack');
    stack.append(create('div', 'message-meta', `${roleLabel(role)} · ${formatTime(message.createdAt)}`), create('div', 'message-bubble', message.text));
    row.append(avatar, stack);
    els.messages.appendChild(row);
    requestAnimationFrame(() => { els.messages.scrollTop = els.messages.scrollHeight; });
  }

  function renderConversation() {
    if (!state.activeSession) {
      setVisible(els.emptyConversation, true, 'grid');
      setVisible(els.conversationView, false);
      return;
    }

    setVisible(els.emptyConversation, false);
    setVisible(els.conversationView, true, 'flex');
    els.activeSessionId.textContent = state.activeSession.id;
    els.activeSessionStatus.textContent = `${statusLabel(state.activeSession.status)}${state.activeSession.assignedTo ? ` · ${state.activeSession.assignedTo}` : ''}`;
    els.claim.disabled = state.activeSession.status === 'human';
    els.release.disabled = state.activeSession.status === 'bot';
    els.messageInput.disabled = false;
    els.messages.textContent = '';
    state.seenMessageIds = new Set();
    for (const message of state.activeSession.messages || []) appendMessage(message);
  }

  async function claimSession() {
    if (!state.activeSession) return;
    try {
      const { session } = await api(`/api/admin/sessions/${encodeURIComponent(state.activeSession.id)}/claim`, {
        method: 'POST', body: JSON.stringify({ adminName: state.adminName })
      });
      state.activeSession = session;
      renderConversation();
      await loadSessions();
    } catch (error) { showToast(error.message); }
  }

  async function releaseSession() {
    if (!state.activeSession) return;
    try {
      const { session } = await api(`/api/admin/sessions/${encodeURIComponent(state.activeSession.id)}/release`, {
        method: 'POST', body: '{}'
      });
      state.activeSession = session;
      renderConversation();
      await loadSessions();
    } catch (error) { showToast(error.message); }
  }

  async function sendAdminMessage(text) {
    if (!state.activeSession) return;
    try {
      await api(`/api/admin/sessions/${encodeURIComponent(state.activeSession.id)}/messages`, {
        method: 'POST', body: JSON.stringify({ message: text, adminName: state.adminName })
      });
      els.messageInput.value = '';
    } catch (error) { showToast(error.message); }
  }

  async function loadOrders() {
    try {
      const { orders } = await api('/api/admin/orders');
      renderOrders(orders);
      els.orderBadge.textContent = String(orders.filter((order) => order.status === 'new').length);
    } catch (error) {
      showToast(error.message);
    }
  }

  function renderOrders(orders) {
    els.ordersList.textContent = '';
    if (!orders.length) {
      const empty = create('div', 'empty-state');
      empty.append(create('div', 'empty-icon', '📦'), create('p', '', 'Chưa có đơn hàng nháp.'));
      els.ordersList.appendChild(empty);
      return;
    }

    for (const order of orders) {
      const card = create('article', 'order-card');
      const head = create('div', 'order-head');
      const title = create('div');
      title.append(create('span', 'eyebrow', 'MÃ ĐƠN'), create('h3', '', order.id), create('p', '', `${formatTime(order.createdAt)} · Phiên ${shortId(order.sessionId)}`));
      const select = create('select', 'order-status');
      const statuses = { new: 'Mới', contacted: 'Đã liên hệ', confirmed: 'Đã xác nhận', cancelled: 'Đã hủy' };
      Object.entries(statuses).forEach(([value, label]) => {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = label;
        option.selected = order.status === value;
        select.appendChild(option);
      });
      select.addEventListener('change', async () => {
        try {
          await api(`/api/admin/orders/${encodeURIComponent(order.id)}`, {
            method: 'PATCH', body: JSON.stringify({ status: select.value })
          });
          showToast('Đã cập nhật trạng thái đơn.');
          loadOrders();
        } catch (error) { showToast(error.message); }
      });
      head.append(title, select);

      const body = create('div', 'order-body');
      const customer = create('div', 'customer-info');
      customer.append(
        create('p', '', `Khách: ${order.customer.name}`),
        create('p', '', `SĐT: ${order.customer.phone}`),
        create('p', '', `Địa chỉ: ${order.customer.address}`),
        create('p', '', `Ghi chú: ${order.customer.note || 'Không có'}`)
      );
      const lines = create('div', 'order-lines');
      for (const item of order.items) {
        const line = create('div', 'order-line');
        const image = create('img');
        image.alt = item.name;
        image.src = /^https?:\/\//.test(item.image || '') ? item.image : PLACEHOLDER_IMAGE;
        image.onerror = () => { image.src = PLACEHOLDER_IMAGE; };
        const info = create('div');
        info.append(create('h4', '', item.name), create('p', '', [item.color, item.size ? `Size ${item.size}` : '', item.sku, `SL ${item.quantity}`].filter(Boolean).join(' · ')));
        line.append(image, info, create('strong', '', formatMoney(item.lineTotal)));
        lines.appendChild(line);
      }
      lines.appendChild(create('div', 'order-total', `Tổng: ${formatMoney(order.total)}`));
      body.append(customer, lines);
      card.append(head, body);
      els.ordersList.appendChild(card);
    }
  }

  function connectEvents() {
    if (state.events) state.events.close();
    state.events = new EventSource(`/api/events/admin?token=${encodeURIComponent(state.token)}`);
    state.events.addEventListener('admin-alert', (event) => {
      const { sessionId } = JSON.parse(event.data);
      showToast(`Khách ${shortId(sessionId)} đang chờ hỗ trợ.`);
      loadSessions();
    });
    state.events.addEventListener('session-updated', (event) => {
      const summary = JSON.parse(event.data);
      const index = state.sessions.findIndex((item) => item.id === summary.id);
      if (index >= 0) state.sessions[index] = { ...state.sessions[index], ...summary };
      else state.sessions.unshift(summary);
      state.sessions.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
      renderSessions();
    });
    state.events.addEventListener('message-new', (event) => {
      const { sessionId, message } = JSON.parse(event.data);
      if (state.activeSession?.id === sessionId) {
        if (!state.activeSession.messages.some((item) => item.id === message.id)) {
          state.activeSession.messages.push(message);
        }
        state.activeSession.status = message.role === 'admin' ? 'human' : state.activeSession.status;
        appendMessage(message);
      }
      loadSessions();
    });
    state.events.addEventListener('order-new', () => {
      showToast('Có đơn nháp mới.');
      loadOrders();
    });
    state.events.onerror = () => {
      if (state.token) els.systemStatus.textContent = 'Mất kết nối cập nhật trực tiếp, đang thử nối lại...';
    };
    state.events.onopen = () => loadHealth();
  }

  async function testAi() {
    els.testAi.disabled = true;
    els.testAi.textContent = 'Đang kiểm tra...';
    try {
      const result = await api('/api/admin/ai-test', { method: 'POST', body: '{}' });
      showToast(result.message);
      loadHealth();
    } catch (error) {
      showToast(error.message);
    } finally {
      els.testAi.disabled = false;
      els.testAi.textContent = 'Test API AI';
    }
  }

  function switchTab(tab) {
    els.tabs.forEach((button) => button.classList.toggle('active', button.dataset.tab === tab));
    setVisible(els.chatsTab, tab === 'chats');
    setVisible(els.ordersTab, tab === 'orders');
    if (tab === 'orders') loadOrders();
  }

  els.loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    els.loginError.textContent = '';
    try {
      await login(els.password.value, els.adminName.value.trim() || 'Nhân viên GHS');
    } catch (error) {
      els.loginError.textContent = error.message;
    }
  });

  els.logout.addEventListener('click', async () => {
    try { await api('/api/admin/logout', { method: 'POST', body: '{}' }); } catch (_) {}
    sessionStorage.removeItem('ghsAdminToken');
    sessionStorage.removeItem('ghsAdminName');
    location.reload();
  });

  els.tabs.forEach((button) => button.addEventListener('click', () => switchTab(button.dataset.tab)));
  els.filters.forEach((button) => button.addEventListener('click', () => {
    state.filter = button.dataset.filter;
    els.filters.forEach((item) => item.classList.toggle('active', item === button));
    renderSessions();
  }));

  // Dùng event delegation: danh sách được render lại bởi SSE vẫn luôn bấm được.
  els.sessionList.addEventListener('click', (event) => {
    const card = event.target.closest('.session-card[data-session-id]');
    if (!card || !els.sessionList.contains(card)) return;
    event.preventDefault();
    openSession(card.dataset.sessionId);
  });

  els.refreshSessions.addEventListener('click', loadSessions);
  els.refreshOrders.addEventListener('click', loadOrders);
  els.claim.addEventListener('click', claimSession);
  els.release.addEventListener('click', releaseSession);
  els.messageForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = els.messageInput.value.trim();
    if (text) sendAdminMessage(text);
  });
  els.messageInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      els.messageForm.requestSubmit();
    }
  });
  els.testAi.addEventListener('click', testAi);

  window.addEventListener('unhandledrejection', (event) => {
    showToast(event.reason?.message || 'Có lỗi khi xử lý thao tác.');
  });

  els.adminName.value = state.adminName;
  if (state.token) {
    (async () => {
      try {
        const { sessions } = await api('/api/admin/sessions');
        state.sessions = sessions;
        setVisible(els.login, false);
        setVisible(els.app, true);
        renderSessions();
        connectEvents();
        await Promise.all([loadHealth(), loadOrders()]);
      } catch (_) {
        sessionStorage.removeItem('ghsAdminToken');
        state.token = '';
        setVisible(els.login, true);
        setVisible(els.app, false);
      }
    })();
  }
})();
