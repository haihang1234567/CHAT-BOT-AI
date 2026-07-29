const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(
  path.resolve(__dirname, '..', 'public', 'css', 'styles.css'),
  'utf8'
);

function rule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`));
  return match?.[1] || '';
}

test('popup biến thể không được phép tràn và cuộn ngang', () => {
  const modal = rule('.modal-card');
  const inner = rule('.modal-inner');
  const directControls = css.match(
    /\.modal-inner > \.field-control,\s*\.modal-inner > \.full-width,\s*\.variant-preview\s*\{([^}]+)\}/
  )?.[1] || '';

  assert.match(modal, /max-width:\s*calc\(100vw - 24px\)/);
  assert.match(modal, /overflow-x:\s*hidden/);
  assert.match(modal, /overflow-y:\s*auto/);
  assert.match(inner, /min-width:\s*0/);
  assert.match(inner, /overflow-x:\s*hidden/);
  assert.match(directControls, /width:\s*calc\(100% - 40px\)/);
});
