import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';

const html = readFileSync(fileURLToPath(new URL('../public/index.html', import.meta.url)), 'utf8');
const script = html.split('<script>')[1].split('const $ =')[0];

function settings(url, keys) {
  const context = { URL, window: { location: { href: url } }, localStorage: { getItem: (key) => keys[key] || null } };
  return vm.runInNewContext(`${script}\n({ api: apiUrl('/api/models'), key: AUTH_KEY, storage: AUTH_STORAGE_KEY })`, context);
}

test('UI API paths and saved keys follow the reverse proxy prefix', () => {
  for (const url of ['https://example.test/cline-pass/', 'https://example.test/cline-pass/index.html']) {
    const result = settings(url, { 'cps_key:/cline-pass': 'scoped', cps_key: 'legacy' });
    assert.equal(result.api, '/cline-pass/api/models');
    assert.equal(result.key, 'scoped');
    assert.equal(result.storage, 'cps_key:/cline-pass');
  }
  const root = settings('http://localhost:3123/', { cps_key: 'legacy' });
  assert.equal(root.api, '/api/models');
  assert.equal(root.key, 'legacy');
  assert.equal(root.storage, 'cps_key:/');
  assert.equal(settings('https://example.test/cline-pass/', { cps_key: 'legacy' }).key, '');
});
