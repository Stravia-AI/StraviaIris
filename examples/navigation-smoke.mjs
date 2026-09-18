// 本地页面在加载等待期间替换文档；验证普通浏览不会因旧 context 的 Promise 取消而退出。
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { chromium } from 'playwright';

const args = new Map(process.argv.slice(2).map(arg => {
  const at = arg.indexOf('=');
  assert(at > 2, '使用 --name=value');
  return [arg.slice(2, at), arg.slice(at + 1)];
}));
for (const key of args.keys()) assert(['executable', 'output', 'mode', 'port'].includes(key), `未知参数 ${key}`);
const executable = resolve(args.get('executable') ?? 'dist/windows-x64/runtime/iris-demo.exe');
const output = resolve(args.get('output') ?? 'out/verification/navigation');
const mode = args.get('mode') ?? 'windowed';
assert(['windowed', 'headless', 'oneshot'].includes(mode));
const oneShot = mode === 'oneshot';
const port = Number(args.get('port') ?? 9246);
assert(Number.isInteger(port) && port > 0 && port <= 65535);
await mkdir(output, { recursive: true });
let held;
let arrived = false;
let finalServed = false;
const server = createServer((request, response) => {
  if (request.url === '/hold') { held = response; return; }
  if (request.url === '/http-redirect') {
    response.writeHead(302, {Location:'/final'});
    response.end();
    return;
  }
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (request.url === '/final') {
    finalServed = true;
    held?.end();
    response.end('<!doctype html><title>Navigation survived</title><h1 id="ready">Final document</h1><script>fetch("/arrived")</script>');
  } else if (request.url === '/arrived') {
    arrived = true;
    response.end('ok');
  } else if (request.url === '/start') {
    response.end(`<!doctype html><title>Initial document</title><script>
      const original = window.addEventListener;
      window.addEventListener = function(type, ...args) {
        const result = original.call(this, type, ...args);
        if (type === 'load') queueMicrotask(() => location.replace('/final'));
        return result;
      };
      window.redirect = () => location.replace('/final');
    </script><img src="/hold">`);
  } else { response.end('<!doctype html><h1 id="again">Second navigation</h1>'); }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
console.log(`navigation fixture listening: ${origin}`);
let stdout = '', stderr = '', connection;
const child = spawn(executable, [
  `--${oneShot ? 'headless' : mode}`, '--seed=42',
  `--cache-dir=${join(output, 'cache')}`,
  `--url=${origin}/${oneShot ? 'http-redirect' : 'start'}`,
  ...(oneShot ? [] : [`--cdp-port=${port}`])
], { cwd: dirname(executable), stdio: ['ignore', 'pipe', 'pipe'] });
let readyResolve;
const ready = new Promise(resolve => { readyResolve = resolve; });
child.stdout.on('data', bytes => { stdout += bytes; if (stdout.includes('iris-demo: Ready')) readyResolve(); });
child.stderr.on('data', bytes => { stderr += bytes; });
const exited = new Promise((resolve, reject) => { child.once('exit', (code, signal) => resolve({code, signal})); child.once('error', reject); });
const unexpectedExit = exited.then(value => { throw new Error(`browser exited before verification: ${JSON.stringify(value)}\n${stderr}`); });
const deadline = AbortSignal.timeout(30000);
const timedOut = new Promise((_, reject) => deadline.addEventListener('abort', () => reject(new Error('navigation verification timeout')), {once:true}));
let outcome;
try {
  await Promise.race([ready, unexpectedExit, timedOut]);
  if (oneShot) {
    outcome = await Promise.race([exited, timedOut]);
    assert.equal(outcome.code, 0, stderr);
    assert(finalServed, '不能在 about:blank 加载完成时提前退出');
  } else {
    connection = await Promise.race([chromium.connectOverCDP(`http://127.0.0.1:${port}`), unexpectedExit, timedOut]);
    const page = connection.contexts()[0].pages()[0];
    assert(page, '必须是 SDK 创建的既有页面');
    await Promise.race([page.waitForFunction(() => typeof window.redirect === 'function' || document.querySelector('#ready')), unexpectedExit, timedOut]);
    await page.evaluate(() => { if (typeof window.redirect === 'function') window.redirect(); });
    await Promise.race([page.locator('#ready').waitFor(), unexpectedExit, timedOut]);
    assert.equal(await page.title(), 'Navigation survived');
    await page.goto(origin + '/again');
    await page.locator('#again').waitFor();
    await page.screenshot({path:join(output, 'screenshot.png')});
    await page.close({runBeforeUnload:true});
    outcome = await Promise.race([exited, timedOut]);
    assert.equal(outcome.code, 0, stderr);
    assert(!stderr.includes('Inspected target navigated or closed'), stderr);
  }
  console.log(oneShot ? 'HTTP redirect and headless load completion passed' : 'navigation replacement and subsequent navigation passed');
} finally {
  await connection?.close().catch(() => {});
  if (child.exitCode === null && child.signalCode === null) {
    try { outcome ??= await Promise.race([exited, timedOut]); }
    catch { child.kill(); await exited; }
  }
  held?.end();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await writeFile(join(output, 'report.json'), JSON.stringify({mode, arrived, finalServed, outcome, stdout, stderr}, null, 2));
}
