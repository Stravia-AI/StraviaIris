// 只连接用户显式指定的本地 CEF；不启动、下载或关闭整个浏览器。
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import puppeteer from 'puppeteer-core';

const args = new Map(process.argv.slice(2).map(arg => {
  const split = arg.indexOf('=');
  assert(split > 2, `需要 --name=value: ${arg}`);
  return [arg.slice(2, split), arg.slice(split + 1)];
}));
for (const key of args.keys()) assert(['endpoint', 'output'].includes(key), `未知参数: ${key}`);
const endpoint = new URL(args.get('endpoint') ?? 'http://127.0.0.1:9222');
assert(endpoint.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname), '仅允许 loopback HTTP CDP endpoint');
const output = resolve(args.get('output') ?? 'out/verification/cdp');
const profile = JSON.parse(await readFile(new URL('../profiles/windows-desktop.json', import.meta.url), 'utf8'));
const lock = JSON.parse(await readFile(new URL('../engine.lock.json', import.meta.url), 'utf8'));
await mkdir(output, { recursive: true });

async function sample(page) {
  return page.evaluate(async () => ({
    userAgent: navigator.userAgent, platform: navigator.platform,
    language: navigator.language, languages: [...navigator.languages],
    hardwareConcurrency: navigator.hardwareConcurrency, deviceMemory: navigator.deviceMemory,
    webdriverType: typeof navigator.webdriver, webdriverPresent: 'webdriver' in navigator,
    webdriverValue: navigator.webdriver,
    highEntropy: await navigator.userAgentData.getHighEntropyValues(['architecture', 'bitness', 'platformVersion', 'uaFullVersion', 'wow64']),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    complete: document.body.dataset.irisComplete === 'true'
  }));
}
function checkIdentity(value) {
  assert.equal(value.platform, profile.platform);
  assert.deepEqual(value.languages, profile.languages);
  assert.equal(value.hardwareConcurrency, profile.hardware_concurrency);
  assert.equal(value.deviceMemory, profile.device_memory);
  assert.equal(value.webdriverType, 'boolean');
  assert.equal(value.webdriverPresent, true);
  assert.equal(value.webdriverValue, false);
  assert.equal(value.highEntropy.architecture, profile.user_agent.architecture);
  assert.equal(value.highEntropy.bitness, profile.user_agent.bitness);
  assert.equal(value.highEntropy.platformVersion, profile.user_agent.platform_version);
  assert.equal(value.highEntropy.wow64, profile.user_agent.wow64);
  assert.equal(value.highEntropy.uaFullVersion, lock.chromium.tag.replace('refs/tags/', ''));
  assert(!value.userAgent.includes('HeadlessChrome'));
  assert(value.complete, '真实导航必须到达 fixture /complete');
}
async function exercise(page, session, name, origin) {
  await session.send('Runtime.enable');
  const marker = `iris-${name}-console`;
  let timer;
  let listener;
  const consoleEvent = new Promise((resolveEvent, reject) => {
    timer = setTimeout(() => reject(new Error(`${name}: console event timeout`)), 10000);
    listener = event => {
      if (event.args?.[0]?.value === marker) resolveEvent(event);
    };
    session.on('Runtime.consoleAPICalled', listener);
  });
  try {
    await page.goto(`${origin}/complete`, { waitUntil: 'load', timeout: 15000 });
    const identity = await sample(page);
    checkIdentity(identity);
    await page.evaluate(value => console.log(value), marker);
    const event = await consoleEvent;
    const file = resolve(output, `${name}.png`);
    const bytes = await page.screenshot({ path: file, type: 'png' });
    assert(Buffer.from(bytes).subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')));
    return { identity, console: { type: event.type, args: event.args }, screenshot: { file, sha256: createHash('sha256').update(bytes).digest('hex') } };
  } finally {
    clearTimeout(timer);
    session.off('Runtime.consoleAPICalled', listener);
  }
}
function fixturePage(pages) {
  for (const page of pages) {
    try {
      const url = new URL(page.url());
      if (url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port !== endpoint.port) return page;
    } catch { /* about:blank 等没有 HTTP origin。 */ }
  }
  throw new Error('未找到运行中的本地 iris-demo fixture 页面');
}

const report = { endpoint: endpoint.href, playwright: null, puppeteer: null };
const pw = await chromium.connectOverCDP(endpoint.href, { timeout: 15000 });
let page;
let originalUrl;
try {
  const context = pw.contexts()[0];
  assert(context, 'CEF 缺少默认 browser context');
  // Alloy 页面由 SDK 的 CefBrowser 生命周期创建。连接模式控制现有页面，
  // 不以 Chrome Target.createTarget 生成缺少 CefBrowser 的裸 WebContents。
  page = fixturePage(context.pages());
  originalUrl = page.url();
  const session = await context.newCDPSession(page);
  report.playwright = await exercise(page, session, 'playwright', new URL(originalUrl).origin);
  await page.goto(originalUrl, { waitUntil: 'load', timeout: 15000 });
  await session.detach();
} finally {
  // connectOverCDP 的 close 仅断开连接；不同于 Browser.close CDP 命令。
  await pw.close();
}
const pp = await puppeteer.connect({ browserURL: endpoint.href, defaultViewport: null, protocolTimeout: 15000 });
try {
  page = fixturePage(await pp.pages());
  originalUrl = page.url();
  const session = await page.createCDPSession();
  report.puppeteer = await exercise(page, session, 'puppeteer', new URL(originalUrl).origin);
  await page.goto(originalUrl, { waitUntil: 'load', timeout: 15000 });
  await session.detach();
  assert.deepEqual(report.playwright.identity, report.puppeteer.identity);
} finally {
  await pp.disconnect();
}
const version = await fetch(new URL('/json/version', endpoint), { signal: AbortSignal.timeout(5000) });
assert(version.ok, '两客户端断开后 CEF 仍须运行');
report.remainingBrowser = await version.json();
await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
console.log(`Playwright 与 Puppeteer 真实 CDP 验收通过：${output}`);
