import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const model = 'cline-pass/deepseek-v4.1-flash-1017';
const directModel = 'cline-pass/direct-test';
const capabilities = ['vision', 'implicit-caching'];

test('capability filters reach the gateway together with upstream routing', async (t) => {
  const calls = [];
  let failingProvider = null;
  const upstream = http.createServer((req, res) => {
    if (req.url === '/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: [] }));
    }
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      calls.push({ body, authorization: req.headers.authorization });
      const provider = body.providerOptions?.gateway?.only?.[0] || body.provider?.only?.[0] || 'deepseek';
      if (provider === failingProvider) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'rate limited' } }));
      }
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        return res.end('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n');
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content: 'OK', provider_metadata: { gateway: { routing: { finalProvider: provider } } } } }],
      }));
    });
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamPort = upstream.address().port;
  const reservation = net.createServer();
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'cline-pass-test-'));
  await writeFile(path.join(dataDir, 'config.json'), JSON.stringify({
    port, upstreamBase: `http://127.0.0.1:${upstreamPort}`,
    accounts: [{ name: 'test', key: 'test-key', enabled: true }],
    knownModels: [model, directModel], perModel: {},
  }));
  await writeFile(path.join(dataDir, 'metadata.json'), JSON.stringify({
    models: {
      [model]: { pipeline: 'planner', upstreams: ['deepseek', 'reserve'] },
      [directModel]: { pipeline: 'direct', upstreams: ['gmicloud'] },
    },
    history: [], catalog: [], catalogFetchedAt: Date.now(),
  }));
  const app = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, DATA_DIR: dataDir, BIND_HOST: '127.0.0.1', PORT: String(port), CLINE_PASS_KEY: '', PROXY_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  app.stdout.on('data', (chunk) => { output += chunk; });
  app.stderr.on('data', (chunk) => { output += chunk; });
  t.after(async () => {
    if (app.exitCode === null && app.signalCode === null) {
      const exited = once(app, 'exit');
      app.kill();
      await exited;
    }
    await new Promise((resolve) => upstream.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    try { ready = (await fetch(`${base}/api/meta`)).ok; } catch {}
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(ready, `proxy did not start: ${output}`);
  const post = async (url, body) => {
    const response = await fetch(`${base}${url}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const setConfig = (id, cfg) => post('/api/config', { perModel: { [id]: cfg } });
  const message = { role: 'user', content: 'OK' };

  await t.test('streaming requests contain the exact configured model, only and has', async () => {
    assert.equal((await setConfig(model, { upstreams: ['deepseek'], pinMode: 'strict', has: capabilities })).status, 200);
    calls.length = 0;
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [message], stream: true }),
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /data: \[DONE\]/);
    assert.equal(response.headers.get('x-cline-target-upstream'), 'deepseek');
    assert.deepEqual(calls[0].body, {
      model, messages: [message], stream: true,
      providerOptions: { gateway: { only: ['deepseek'], has: capabilities } },
    });
    assert.equal(calls[0].authorization, 'Bearer test-key');
  });

  await t.test('preferred routing preserves client capabilities and gateway options', async () => {
    await setConfig(model, { upstreams: ['deepseek', 'reserve'], pinMode: 'preferred', has: capabilities });
    calls.length = 0;
    const r = await post('/v1/chat/completions', {
      model, messages: [message],
      providerOptions: { gateway: { has: ['structured-outputs'], custom: 'keep' }, other: { keep: true } },
    });
    assert.equal(r.status, 200);
    assert.deepEqual(calls[0].body.providerOptions, {
      gateway: { has: ['structured-outputs', ...capabilities], custom: 'keep', order: ['deepseek', 'reserve'] },
      other: { keep: true },
    });
  });

  await t.test('strict fallback retains capabilities on every attempt', async () => {
    await setConfig(model, { upstreams: ['deepseek', 'reserve'], pinMode: 'strict', has: capabilities });
    calls.length = 0;
    failingProvider = 'deepseek';
    const r = await post('/v1/chat/completions', { model, messages: [message] });
    failingProvider = null;
    assert.equal(r.status, 200);
    assert.deepEqual(calls.map((c) => c.body.providerOptions.gateway), [
      { only: ['deepseek'], has: capabilities },
      { only: ['reserve'], has: capabilities },
    ]);
  });

  await t.test('test and validation requests use the configured capabilities', async () => {
    calls.length = 0;
    const result = await post('/api/test', { model, upstreams: ['deepseek'] });
    assert.equal(result.body.ok, true);
    assert.deepEqual(calls[0].body.providerOptions.gateway, { only: ['deepseek'], has: capabilities });
    calls.length = 0;
    const validation = await post('/api/validate-upstreams', { model });
    assert.equal(validation.body.ok, true);
    assert.equal(calls.length, 2);
    for (const { body } of calls) {
      assert.equal(body.providerOptions.gateway.only.length, 1);
      assert.deepEqual(body.providerOptions.gateway.has, capabilities);
    }
  });

  await t.test('configuration survives older clients and rejects invalid capabilities', async () => {
    await setConfig(model, { upstreams: ['deepseek'], pinMode: 'strict' });
    const invalid = await setConfig(model, { upstreams: ['reserve'], has: ['vision', 'unsupported'] });
    assert.equal(invalid.status, 400);
    const saved = JSON.parse(await readFile(path.join(dataDir, 'config.json'), 'utf8')).perModel[model];
    assert.deepEqual(saved.has, capabilities);
    assert.deepEqual(saved.upstreams, ['deepseek']);
    calls.length = 0;
    const invalidRequest = await post('/v1/chat/completions', {
      model, messages: [message], providerOptions: { gateway: { has: 'vision' } },
    });
    assert.equal(invalidRequest.status, 400);
    assert.equal(calls.length, 0);
  });

  await t.test('known direct routing rejects unsupported capability filtering', async () => {
    await setConfig(directModel, { upstreams: ['gmicloud'], pinMode: 'strict', has: capabilities });
    calls.length = 0;
    const chat = await post('/v1/chat/completions', { model: directModel, messages: [message] });
    assert.equal(chat.status, 400);
    assert.match(chat.body.error.message, /OpenRouter/);
    const probe = await post('/api/test', { model: directModel });
    assert.equal(probe.body.ok, false);
    const validation = await post('/api/validate-upstreams', { model: directModel });
    assert.equal(validation.status, 400);
    assert.equal(calls.length, 0);
  });

  await t.test('direct routing and incoming capability options remain unchanged when disabled', async () => {
    await setConfig(directModel, { upstreams: ['gmicloud'], pinMode: 'strict', has: [] });
    calls.length = 0;
    const direct = await post('/v1/chat/completions', { model: directModel, messages: [message] });
    assert.equal(direct.status, 200);
    assert.deepEqual(calls[0].body.provider, { only: ['gmicloud'] });
    assert.equal(calls[0].body.providerOptions, undefined);

    await setConfig(model, { upstreams: [], pinMode: 'strict', has: [] });
    calls.length = 0;
    await post('/v1/chat/completions', {
      model, messages: [message], providerOptions: { gateway: { has: ['vision'] } },
    });
    assert.deepEqual(calls[0].body.providerOptions.gateway.has, ['vision']);
  });

  await t.test('unknown pipelines receive both forms and streamed new models are listed', async () => {
    const newModel = 'cline-pass/new-streaming-model';
    await setConfig(newModel, { upstreams: ['deepseek'], pinMode: 'strict', has: capabilities });
    calls.length = 0;
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: newModel, messages: [message], stream: true }),
    });
    assert.equal(response.status, 200);
    await response.text();
    assert.deepEqual(calls[0].body.providerOptions.gateway, { only: ['deepseek'], has: capabilities });
    assert.deepEqual(calls[0].body.provider, { only: ['deepseek'] });
    const models = await (await fetch(`${base}/api/models`)).json();
    assert.ok(models.subscription.some((entry) => entry.id === newModel));
  });
});
