const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class JsonStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = { sessions: {}, orders: [] };
    this.load();
  }

  load() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (!fs.existsSync(this.filePath)) {
      this.persist();
      return;
    }

    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      this.data.sessions = parsed.sessions || {};
      this.data.orders = Array.isArray(parsed.orders) ? parsed.orders : [];
    } catch (error) {
      console.error('Không đọc được kho dữ liệu local, tạo kho mới:', error.message);
      const backup = `${this.filePath}.broken-${Date.now()}`;
      try { fs.copyFileSync(this.filePath, backup); } catch (_) {}
      this.data = { sessions: {}, orders: [] };
      this.persist();
    }
  }

  persist() {
    const tempPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(tempPath, this.filePath);
  }

  now() {
    return new Date().toISOString();
  }

  ensureSession(sessionId) {
    if (!sessionId || typeof sessionId !== 'string') {
      throw new Error('Thiếu sessionId hợp lệ.');
    }

    if (!this.data.sessions[sessionId]) {
      const now = this.now();
      this.data.sessions[sessionId] = {
        id: sessionId,
        status: 'bot',
        assignedTo: null,
        createdAt: now,
        updatedAt: now,
        messages: []
      };
      this.persist();
    }
    return this.data.sessions[sessionId];
  }

  addMessage(sessionId, role, text, extra = {}) {
    const session = this.ensureSession(sessionId);
    const message = {
      id: crypto.randomUUID(),
      role,
      text: String(text || '').trim(),
      createdAt: this.now(),
      ...extra
    };
    session.messages.push(message);
    session.updatedAt = message.createdAt;
    this.persist();
    return message;
  }

  setSessionStatus(sessionId, status, assignedTo = null) {
    const session = this.ensureSession(sessionId);
    session.status = status;
    session.assignedTo = assignedTo;
    session.updatedAt = this.now();
    this.persist();
    return session;
  }

  getSession(sessionId) {
    return this.data.sessions[sessionId] || null;
  }

  listSessions() {
    return Object.values(this.data.sessions)
      .map((session) => ({
        id: session.id,
        status: session.status,
        assignedTo: session.assignedTo,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        messageCount: session.messages.length,
        lastMessage: session.messages.at(-1) || null
      }))
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  }

  createOrder(order) {
    this.data.orders.unshift(order);
    this.persist();
    return order;
  }

  listOrders() {
    return [...this.data.orders].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  updateOrderStatus(orderId, status) {
    const order = this.data.orders.find((item) => item.id === orderId);
    if (!order) return null;
    order.status = status;
    order.updatedAt = this.now();
    this.persist();
    return order;
  }
}

module.exports = JsonStore;
