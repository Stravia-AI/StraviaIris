// 连接既有 CEF 页面，以本地 STUN 收包验证策略；不使用外部 STUN/TURN。
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { chromium } from 'playwright';

const args = new Map(process.argv.slice(2).map(arg => {
  const split = arg.indexOf('=');
  assert(split > 2, `需要 --name=value: ${arg}`);
  return [arg.slice(2, split), arg.slice(split + 1)];
}));
for (const key of args.keys()) assert(['endpoint', 'expect', 'output'].includes(key), `未知参数: ${key}`);
const endpoint = new URL(args.get('endpoint') ?? 'http://127.0.0.1:9222');
assert(endpoint.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname), '仅允许 loopback CDP');
const expected = args.get('expect') ?? 'blocked';
assert(['blocked', 'direct'].includes(expected), 'expect 必须为 blocked 或 direct');
const output = resolve(args.get('output') ?? 'out/verification/ice.json');
const socket = dgram.createSocket('udp4');
const packets = [];
let socketFailure;
let controlResolve;
const control = Buffer.from('iris-loopback-listener-control');
const controlReceived = new Promise(resolveControl => { controlResolve = resolveControl; });
socket.on('error', error => { socketFailure = error; });
socket.on('message', (message, remote) => {
  if (message.equals(control)) { controlResolve(); return; }
  const binding = message.length >= 20 && message.readUInt16BE(0) === 1 && message.readUInt32BE(4) === 0x2112a442;
  packets.push({ bytes: message.length, bindingRequest: binding });
  if (!binding) return;
  // RFC 5389 Binding Success + XOR-MAPPED-ADDRESS，反映真实接收源，不伪造路由。
  const reply = Buffer.alloc(32);
  reply.writeUInt16BE(0x0101, 0);
  reply.writeUInt16BE(12, 2);
  reply.writeUInt32BE(0x2112a442, 4);
  message.copy(reply, 8, 8, 20);
  reply.writeUInt16BE(0x0020, 20);
  reply.writeUInt16BE(8, 22);
  reply[25] = 1;
  reply.writeUInt16BE(remote.port ^ 0x2112, 26);
  const address = remote.address.split('.').reduce((value, octet) => (value << 8) | Number(octet), 0);
  reply.writeUInt32BE((address ^ 0x2112a442) >>> 0, 28);
  socket.send(reply, remote.port, remote.address, error => { if (error) socketFailure = error; });
});
let browser;
try {
  await new Promise((resolveListening, reject) => {
    socket.once('error', reject);
    socket.bind(0, '127.0.0.1', resolveListening);
  });
  const port = socket.address().port;
  socket.send(control, port, '127.0.0.1');
  let controlTimer;
  try {
    await Promise.race([controlReceived, new Promise((_, reject) => {
      controlTimer = setTimeout(() => reject(new Error('loopback UDP control 未收到')), 5000);
    })]);
  } finally { clearTimeout(controlTimer); }
  browser = await chromium.connectOverCDP(endpoint.href, { timeout: 15000 });
  const page = browser.contexts().flatMap(context => context.pages()).find(page => {
    try { return new URL(page.url()).hostname === '127.0.0.1'; } catch { return false; }
  });
  assert(page, '未找到已打开的本地测试页面');
  const ice = await page.evaluate(async port => {
    const peer = new RTCPeerConnection({ iceServers: [{ urls: `stun:127.0.0.1:${port}` }] });
    const candidates = [];
    let timer;
    try {
      peer.onicecandidate = event => {
        if (!event.candidate) return;
        const candidate = event.candidate;
        candidates.push({ type: candidate.type, protocol: candidate.protocol,
          literalAddress: /^(?:\d{1,3}\.){3}\d{1,3}$/.test(candidate.address) || candidate.address?.includes(':') === true });
      };
      const complete = new Promise((resolveComplete, reject) => {
        timer = setTimeout(() => reject(new Error('ICE gathering 未完成')), 10000);
        peer.onicegatheringstatechange = () => {
          if (peer.iceGatheringState === 'complete') resolveComplete();
        };
      });
      peer.createDataChannel('iris-loopback-policy');
      await peer.setLocalDescription(await peer.createOffer());
      await complete;
      return { gatheringState: peer.iceGatheringState, candidates };
    } finally { clearTimeout(timer); peer.close(); }
  }, port);
  if (socketFailure) throw socketFailure;
  const report = { endpoint: endpoint.href, expected, listener: '127.0.0.1', controlReceived: true, packets, ice };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2));
  if (expected === 'blocked') {
    assert.equal(packets.length, 0, '发现未代理的 loopback UDP');
    assert.equal(ice.candidates.length, 0, '无代理/中继配置时不应暴露 ICE 地址');
  } else {
    assert(packets.some(packet => packet.bindingRequest), '原版正对照未向真实 UDP listener 发出 STUN 请求');
  }
  console.log(`ICE ${expected} 验收通过；STUN 数据包=${packets.length}；${output}`);
} finally {
  if (browser) await browser.close();
  socket.close();
}
