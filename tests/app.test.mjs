// End-to-end checks for dist/index.html in Chromium.
//
//   npm test
//
// The claude.ai viewer runtime (window.claude.use) is replaced by a stand-in so the
// page's generate / follow-up / stop / error / save paths run without a network.
// CDN scripts are served from node_modules; fonts are blocked.
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const html = readFileSync(join(root, 'dist/index.html'), 'utf8');
const systemPrompt = readFileSync(join(root, 'prompts/1_시스템프롬프트.md'), 'utf8');
const markedJs = readFileSync(join(dirname(require.resolve('marked/package.json')), 'marked.min.js'), 'utf8');
const purifyJs = readFileSync(join(dirname(require.resolve('dompurify/package.json')), 'dist/purify.min.js'), 'utf8');
const outDir = join(root, 'test-output');
mkdirSync(outDir, { recursive: true });

const ORIGIN = 'https://app.test';
const launchOpts = process.env.PLAYWRIGHT_BROWSERS_PATH ? {} : { executablePath: '/opt/pw-browsers/chromium' };

const ANSWER = [
  '가정: 기본 교육과정(교사 입력) · 2022 개정',
  '',
  '### 1. 학생 요약',
  '- **학생 A**: 편의점 간식을 좋아함',
  '',
  '### 2. 교육과정 연계',
  '- 성취기준: `[성취기준 확인 필요: 수학/중1~3]`',
  '',
  '### 7. 학습자료',
  '| 순서 | 그림 |',
  '|---|---|',
  '| 1 | [그림: 간식을 고르는 손] |',
  '',
  '- ⚠️ 먹는 활동은 식이 지침을 확인하세요.',
  '<img src=x onerror="window.__xss=1">',
].join('\n');

// Runs in the page before any page script: a stand-in for the viewer runtime.
function installFakeRuntime(answer) {
  const calls = [];
  const saves = [];
  window.__calls = calls;
  window.__saves = saves;
  window.__behavior = 'ok';
  const sample = (input, opts) => new Promise((resolve, reject) => {
    calls.push({ input, opts: { modelTier: opts.modelTier, cache: opts.cache } });
    const behavior = window.__behavior;
    if (behavior === 'rate_limited') { setTimeout(() => reject({ code: 'rate_limited', message: 'slow down' }), 30); return; }
    const chunks = answer.match(/[\s\S]{1,40}/g);
    let i = 0, text = '';
    const timer = setInterval(() => {
      if (opts.signal && opts.signal.aborted) {
        clearInterval(timer);
        reject({ code: 'cancelled', message: 'aborted', text: text || undefined });
        return;
      }
      if (i >= chunks.length) {
        clearInterval(timer);
        resolve({ text, truncated: false, modelTierApplied: opts.modelTier });
        return;
      }
      text += chunks[i++];
      opts.onText({ text, delta: chunks[i - 1] });
    }, behavior === 'slow' ? 400 : 15);
  });
  const downloads = { save: (req) => { saves.push({ filename: req.filename, head: String(req.data).slice(0, 200), size: String(req.data).length }); return Promise.resolve({ status: 'saved' }); } };
  window.claude = {
    use: (name) => new Promise((r) => setTimeout(() => r(name === 'sample' ? sample : name === 'downloads' ? downloads : null), 60)),
  };
}

async function newPage(browser, { live, viewport, colorScheme } = {}) {
  const context = await browser.newContext({ viewport: viewport || { width: 1360, height: 900 }, colorScheme: colorScheme || 'light' });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: ORIGIN });
  await context.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith(ORIGIN)) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
    if (url.includes('cdnjs.cloudflare.com/ajax/libs/marked/12.0.2/marked.min.js')) return route.fulfill({ contentType: 'application/javascript', body: markedJs });
    if (url.includes('cdnjs.cloudflare.com/ajax/libs/dompurify/3.1.6/purify.min.js')) return route.fulfill({ contentType: 'application/javascript', body: purifyJs });
    return route.abort();
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  if (live) await page.addInitScript(installFakeRuntime, ANSWER);
  await page.goto(ORIGIN + '/');
  return { page, context, errors };
}

const results = [];
async function check(name, fn) {
  try { await fn(); results.push(['ok', name]); }
  catch (e) { results.push(['FAIL', name, e]); }
}

const browser = await chromium.launch(launchOpts);

await check('copy mode: example renders with marks, copy button copies full prompt', async () => {
  const { page, errors } = await newPage(browser);
  await page.waitForSelector('.status[data-mode="copy"]');
  assert.equal(await page.isHidden('#btn-generate'), true, 'generate hidden in copy mode');
  assert.equal(await page.isVisible('#copy-mode-bar'), true);
  const ex = page.locator('.turn[data-state="example"]');
  assert.equal(await ex.count(), 1);
  assert.ok(await ex.locator('.doc mark.verify').count() >= 2, 'verify marks');
  assert.ok(await ex.locator('.doc .pic').count() >= 5, 'picture placeholders');
  assert.equal(await ex.locator('.doc .assume').count(), 1, 'assumption line');
  assert.ok(await ex.locator('.doc .safety').count() >= 1, 'safety callout');
  assert.equal(await ex.locator('.flag.assume').count(), 1, 'assumption chip');
  assert.ok(await ex.locator('.table-wrap table').count() >= 4, 'tables wrapped');
  await page.click('#btn-copy-prompt');
  await page.waitForSelector('#toast:not([hidden])');
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  assert.ok(clip.includes('<지시문>') && clip.includes(systemPrompt.trim().slice(0, 60)), 'system prompt in copy');
  assert.ok(clip.includes('## 7. 학교 성취기준'), 'reference in copy');
  assert.ok(clip.includes('<교사 요청>\n가명: 학생 A\n★ 학년(필요하면 만 나이): 중학교 2학년'), 'request in copy');
  assert.deepEqual(errors, []);
  await page.screenshot({ path: join(outDir, 'desktop-light.png'), fullPage: false });
  await page.context().close();
});

await check('live mode: generate streams, sends rules + form, follow-up keeps history', async () => {
  const { page, errors } = await newPage(browser, { live: true });
  await page.waitForSelector('.status[data-mode="live"]');
  assert.equal(await page.isVisible('#btn-generate'), true);
  assert.equal(await page.locator('.cmd').first().isDisabled(), true, 'follow-ups disabled on example');
  await page.click('#btn-generate');
  await page.waitForSelector('.turn[data-state="streaming"]');
  await page.waitForSelector('.turn[data-state="done"]');
  const calls = await page.evaluate(() => window.__calls);
  assert.equal(calls.length, 1);
  const [rules, req] = calls[0].input;
  assert.equal(rules.role, 'user');
  assert.ok(rules.content.includes('<지시문>\n' + systemPrompt.trim()), 'full system prompt in instructions turn');
  assert.ok(rules.content.includes('(비어 있음: 교사가 붙여 넣은 성취기준이 없습니다.)'));
  assert.match(rules.content, /오늘 날짜: \d{4}-\d{2}-\d{2} \(\d{4}학년도\)/);
  assert.ok(req.content.includes('수업 형태: 소집단   시간: 45분'), 'format + minutes line');
  assert.ok(req.content.includes('소집단 학생별 1줄:\n- 학생 B: 지적장애'), 'group lines');
  assert.ok(req.content.indexOf('보조공학') === -1, 'empty fields left out');
  assert.equal(calls[0].opts.cache, false);
  assert.equal(calls[0].opts.modelTier, 'default');
  const done = page.locator('.turn[data-state="done"]');
  assert.equal(await done.locator('.doc mark.verify').count(), 1);
  assert.equal(await done.locator('.flag.verify').count(), 1);
  assert.equal(await done.locator('.flag.safety').count(), 1);
  assert.equal(await page.evaluate(() => window.__xss), undefined, 'html sanitized');
  assert.equal(await page.locator('.turn[data-state="example"]').count(), 0, 'example replaced');

  await page.click('.cmd[data-cmd="/자료 1"]');
  await page.waitForFunction(() => document.querySelectorAll('.turn[data-state="done"]').length === 2);
  const calls2 = await page.evaluate(() => window.__calls);
  const roles = calls2[1].input.map((t) => t.role);
  assert.deepEqual(roles, ['user', 'user', 'assistant', 'user']);
  assert.equal(calls2[1].input[3].content, '/자료 1');

  await page.fill('#fu-text', '학생 A 목표를 받기까지로 해 주세요');
  await page.press('#fu-text', 'Enter');
  await page.waitForFunction(() => document.querySelectorAll('.turn[data-state="done"]').length === 3);

  await page.locator('.turn[data-state="done"]').first().locator('[data-act="html"]').click();
  await page.waitForFunction(() => window.__saves.length === 1);
  const saves = await page.evaluate(() => window.__saves);
  assert.match(saves[0].filename, /^수업안-\d{4}-\d{2}-\d{2}-\d{4}\.html$/);
  assert.ok(saves[0].head.startsWith('<!doctype html>'));

  // reload keeps the conversation for this tab
  await page.reload();
  await page.waitForSelector('.status[data-mode="live"]');
  assert.equal(await page.locator('.turn').count(), 3, 'thread restored');
  assert.equal(await page.locator('.cmd').first().isDisabled(), false);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: join(outDir, 'desktop-live.png') });
  await page.context().close();
});

await check('live mode: stop, rate limit, and retry', async () => {
  const { page, errors } = await newPage(browser, { live: true });
  await page.waitForSelector('.status[data-mode="live"]');
  await page.evaluate(() => { window.__behavior = 'slow'; });
  await page.click('#btn-generate');
  await page.waitForFunction(() => document.querySelector('.turn .doc') && document.querySelector('.turn .doc').textContent.length > 0);
  assert.equal(await page.isDisabled('#btn-generate'), true, 'generate disabled while busy');
  await page.click('[data-act="stop"]');
  await page.waitForFunction(() => document.querySelector('.turn[data-state="error"] .turn-note') && !document.querySelector('.turn[data-state="error"] .turn-note').hidden);
  assert.match(await page.textContent('.turn[data-state="error"] .turn-note'), /중지했습니다/);
  assert.equal(await page.isDisabled('#btn-generate'), false);

  await page.evaluate(() => { window.__behavior = 'rate_limited'; });
  await page.click('#btn-generate');
  await page.waitForSelector('.turn-note:has-text("잠시 뒤")');
  assert.equal(await page.locator('.turn-note button:has-text("다시 시도")').count(), 1);
  await page.evaluate(() => { window.__behavior = 'ok'; });
  await page.click('.turn-note button:has-text("다시 시도")');
  await page.waitForSelector('.turn[data-state="done"]');
  const calls = await page.evaluate(() => window.__calls);
  const last = calls[calls.length - 1].input;
  assert.deepEqual(last.map((t) => t.role), ['user', 'user'], 'failed request not duplicated on retry');
  assert.deepEqual(errors, []);
  await page.context().close();
});

await check('personal-info check holds the request until the teacher decides', async () => {
  const { page } = await newPage(browser, { live: true });
  await page.waitForSelector('.status[data-mode="live"]');
  await page.fill('#f-behavior', '보호자 연락처 010-1234-5678, 서울행복중학교 2학년 3반');
  await page.click('#btn-generate');
  await page.waitForSelector('#pii-box:not([hidden])');
  const items = await page.locator('#pii-list li').allTextContents();
  assert.ok(items.some((t) => t.startsWith('전화번호')));
  assert.ok(items.some((t) => t.startsWith('학교 이름')));
  assert.ok(items.some((t) => t.startsWith('학급·반')));
  await page.click('#pii-fix');
  await page.waitForTimeout(200);
  assert.equal((await page.evaluate(() => window.__calls)).length, 0, 'nothing sent after 고칠게요');
  await page.click('#btn-generate');
  await page.click('#pii-send');
  await page.waitForSelector('.turn[data-state="done"]');
  assert.equal((await page.evaluate(() => window.__calls)).length, 1);
  await page.context().close();
});

await check('required fields and school standards', async () => {
  const { page } = await newPage(browser, { live: true });
  await page.waitForSelector('.status[data-mode="live"]');
  await page.click('#btn-clear');
  await page.click('#btn-generate');
  assert.equal(await page.getAttribute('#f-grade', 'aria-invalid'), 'true');
  assert.equal((await page.evaluate(() => window.__calls)).length, 0);

  await page.click('#btn-standards');
  await page.fill('#std-text', '개정 연도: 2022 / 교육과정: 기본 / 교과: 수학 / 학년군: 중1~3\n[테스트01-01] 테스트 성취기준 문구');
  await page.click('#std-save');
  assert.equal(await page.textContent('#std-count'), '1');

  await page.click('#tab-quick');
  await page.click('#quick-examples .chip >> nth=0');
  await page.selectOption('#opt-length', 'brief');
  await page.click('#btn-generate');
  await page.waitForSelector('.turn[data-state="done"]');
  const call = (await page.evaluate(() => window.__calls))[0];
  assert.ok(call.input[0].content.includes('[테스트01-01] 테스트 성취기준 문구'), 'standards in section 7');
  assert.equal(call.input[1].content, '초4 지적장애, 국어 낱말 읽기, 그림 좋아함, /간단');
  await page.context().close();
});

await check('phone width: no sideways scroll, dark theme readable', async () => {
  for (const colorScheme of ['light', 'dark']) {
    const { page, errors } = await newPage(browser, { viewport: { width: 390, height: 844 }, colorScheme });
    await page.waitForSelector('.status[data-mode="copy"]');
    const { sw, iw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
    assert.ok(sw <= iw, `scrollWidth ${sw} > innerWidth ${iw} (${colorScheme})`);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: join(outDir, `phone-${colorScheme}.png`), fullPage: true });
    await page.context().close();
  }
  const { page } = await newPage(browser, { colorScheme: 'dark' });
  await page.waitForSelector('.status[data-mode="copy"]');
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  assert.notEqual(bg, 'rgb(243, 245, 241)', 'dark background applied');
  await page.screenshot({ path: join(outDir, 'desktop-dark.png') });
  await page.context().close();
});

await check('no clipboard access: copy opens the manual-copy dialog with the prompt selected', async () => {
  const context = await browser.newContext();
  const insecure = 'http://app.test';
  await context.route('**/*', (route) => route.request().url().startsWith(insecure)
    ? route.fulfill({ contentType: 'text/html; charset=utf-8', body: html })
    : route.abort());
  const page = await context.newPage();
  await page.goto(insecure + '/');
  await page.waitForSelector('.status[data-mode="copy"]');
  await page.click('#btn-copy-prompt');
  await page.waitForSelector('#dlg-copy[open]');
  const sel = await page.evaluate(() => { const t = document.getElementById('copy-text'); return t.value.slice(t.selectionStart, t.selectionEnd); });
  assert.ok(sel.includes('<지시문>') && sel.includes('<교사 요청>'));
  await context.close();
});

await check('libraries missing: answer still shows as plain text', async () => {
  const context = await browser.newContext();
  await context.route('**/*', (route) => route.request().url().startsWith(ORIGIN)
    ? route.fulfill({ contentType: 'text/html; charset=utf-8', body: html })
    : route.abort());
  const page = await context.newPage();
  await page.goto(ORIGIN + '/');
  await page.waitForSelector('.doc.plain');
  assert.ok((await page.textContent('.doc.plain')).includes('### 1. 학생 요약'));
  await context.close();
});

await browser.close();

let failed = 0;
for (const [status, name, err] of results) {
  console.log(`${status === 'ok' ? '✓' : '✗'} ${name}`);
  if (err) { failed++; console.log('   ', err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n    ') : err); }
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
