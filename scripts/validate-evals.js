const fs = require('fs');
const path = require('path');

const filePath = path.resolve(__dirname, '..', 'evals', 'customer-questions.json');
const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
const cases = Array.isArray(parsed?.cases) ? parsed.cases : null;

if (!cases) throw new Error('evals/customer-questions.json phải có mảng cases.');

const ids = new Set();
for (const [index, item] of cases.entries()) {
  if (!item || typeof item !== 'object') throw new Error(`cases[${index}] không hợp lệ.`);
  if (!String(item.id || '').trim()) throw new Error(`cases[${index}] thiếu id.`);
  if (!String(item.question || '').trim()) throw new Error(`${item.id}: thiếu question.`);
  if (!item.expected || typeof item.expected !== 'object') {
    throw new Error(`${item.id}: thiếu expected.`);
  }
  if (ids.has(item.id)) throw new Error(`${item.id}: id bị trùng.`);
  ids.add(item.id);
}

console.log(`Eval hợp lệ: ${cases.length} câu hỏi.`);
