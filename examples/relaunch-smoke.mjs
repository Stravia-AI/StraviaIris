// 已有实例保持运行；同 cache 的第二次启动不得创建脱离 SDK 生命周期的窗口。
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const args = new Map(process.argv.slice(2).map(arg => {
  const split = arg.indexOf('=');
  assert(split > 2, `需要 --name=value: ${arg}`);
  return [arg.slice(2, split), arg.slice(split + 1)];
}));
for (const key of args.keys()) assert(['endpoint', 'executable', 'cache-dir', 'output'].includes(key), `未知参数: ${key}`);
const endpoint = new URL(args.get('endpoint') ?? 'http://127.0.0.1:9222');
assert(endpoint.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname), '仅允许 loopback CDP');
assert(args.has('executable') && args.has('cache-dir'), '需要现有实例的 executable 与 cache-dir');
const executable = resolve(args.get('executable'));
const cache = resolve(args.get('cache-dir'));
const output = resolve(args.get('output') ?? 'out/verification/relaunch.json');
async function pages() {
  const response = await fetch(new URL('/json/list', endpoint), { signal: AbortSignal.timeout(5000) });
  assert(response.ok, '已有实例 CDP 不可用');
  return (await response.json()).filter(target => target.type === 'page')
    .map(({ id, url }) => ({ id, url })).sort((a, b) => a.id.localeCompare(b.id));
}
const before = await pages();
assert(before.length > 0, '已有实例必须拥有真实页面');
const child = await new Promise(resolveChild => {
  execFile(executable, ['--headless', '--seed=42', `--cache-dir=${cache}`, '--self-test',
    `--output-dir=${output}.unexpected`], { timeout: 20000, windowsHide: true }, (error, stdout, stderr) => {
    resolveChild({ exitCode: error?.code ?? 0, signal: error?.signal ?? null,
      killed: error?.killed ?? false, stdout, stderr });
  });
});
const after = await pages();
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify({ endpoint: endpoint.href, executable, cache, before, child, after }, null, 2));
assert.equal(child.killed, false, '第二次启动没有自行退出');
assert.equal(child.exitCode, 1, '第二次启动必须报告失败');
assert.deepEqual(after, before, 'cache 拒绝改变了已有实例的页面集合或导航');
console.log(`重复 cache 已拒绝，既有窗口集合保持不变：${output}`);
