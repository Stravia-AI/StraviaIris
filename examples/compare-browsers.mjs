// 只连接专用测试实例；保存原始观测，不把 Iris 自检断言当成 Owl 的契约。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const args = new Map(process.argv.slice(2).map(arg => {
  const at = arg.indexOf('=');
  assert(at > 2, '使用 --name=value');
  return [arg.slice(2, at), arg.slice(at + 1)];
}));
for (const key of args.keys()) assert(['iris-endpoint', 'owl-endpoint', 'output'].includes(key), `未知参数 ${key}`);
const output = resolve(args.get('output') ?? 'out/verification/owl-observables/comparison');
const endpoints = Object.fromEntries(['iris', 'owl'].map((name, index) => {
  const endpoint = new URL(args.get(`${name}-endpoint`) ?? `http://127.0.0.1:${9340 + index}`);
  assert(endpoint.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname), '仅允许专用 loopback CDP');
  return [name, endpoint.href];
}));
await mkdir(output, {recursive:true});
const connections = {};
const reports = {};
const failures = [];

// 不启用 Target.setAutoAttach：Owl 的跨站帧会在自动附加子目标时停止提交。
async function connect(endpoint) {
  const response = await fetch(new URL('json/list', endpoint), {signal:AbortSignal.timeout(10000)});
  assert(response.ok, `CDP target list: ${response.status}`);
  const target = (await response.json()).find(t => t.type === 'page');
  assert(target?.webSocketDebuggerUrl, '必须存在浏览器自身创建的页面');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map(), listeners = new Set();
  let sequence = 0;
  const rejectPending = error => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
    pending.clear();
  };
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(JSON.stringify(message.error)));
      else request.resolve(message.result);
    } else {
      for (const listener of listeners) listener(message);
    }
  });
  socket.addEventListener('close', () => rejectPending(new Error('CDP connection closed')));
  try {
    await new Promise((resolveOpen, rejectOpen) => {
      const timer = setTimeout(() => rejectOpen(new Error('CDP connection timeout')), 10000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolveOpen(); }, {once:true});
      socket.addEventListener('error', () => { clearTimeout(timer); rejectOpen(new Error('CDP connection error')); }, {once:true});
    });
  } catch (error) { socket.close(); throw error; }
  const send = (method, params = {}) => new Promise((resolveRequest, rejectRequest) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      rejectRequest(new Error(`CDP command timeout: ${method}`));
    }, 45000);
    pending.set(id, {resolve:resolveRequest, reject:rejectRequest, timer});
    socket.send(JSON.stringify({id, method, params}));
  });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', {expression, awaitPromise:true, returnByValue:true});
    assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const navigate = async url => {
    await send('Page.enable');
    await send('Page.setLifecycleEventsEnabled', {enabled:true});
    let expected, settle, rejectLoad, timer;
    const seen = [];
    const loaded = new Promise((resolveLoad, reject) => {
      settle = resolveLoad;
      rejectLoad = reject;
      timer = setTimeout(() => reject(new Error('main document load timeout')), 30000);
    });
    const matches = event => expected && event.frameId === expected.frameId && event.loaderId === expected.loaderId;
    const listener = message => {
      if (message.method !== 'Page.lifecycleEvent' || message.params.name !== 'load') return;
      seen.push(message.params);
      if (matches(message.params)) settle();
    };
    listeners.add(listener);
    try {
      expected = await Promise.race([send('Page.navigate', {url}), loaded]);
      assert(!expected.errorText, expected.errorText);
      if (seen.some(matches)) settle();
      await loaded;
    } catch (error) {
      rejectLoad(error);
      await loaded.catch(() => {});
      throw error;
    } finally { clearTimeout(timer); listeners.delete(listener); }
  };
  return {url:target.url, send, evaluate, navigate, close:() => {
    rejectPending(new Error('CDP connection released'));
    socket.close();
  }};
}

async function supplemental() {
  const safe = fn => { try { const value = fn(); return value === undefined ? {type:'undefined'} : value; } catch (error) { return {error:{name:error.name, message:error.message}}; } };
  const asyncSafe = async fn => { try { return await fn(); } catch (error) { return {error:{name:error.name, message:error.message}}; } };
  const descriptors = prototype => Object.fromEntries(Object.getOwnPropertyNames(prototype).sort().map(key => {
    const d = Object.getOwnPropertyDescriptor(prototype, key);
    return [key, {enumerable:d.enumerable, configurable:d.configurable, writable:d.writable,
      get:d.get ? Function.prototype.toString.call(d.get) : null,
      set:d.set ? Function.prototype.toString.call(d.set) : null,
      valueType:typeof d.value}];
  }));
  const mediaQueries = ['(prefers-color-scheme: dark)', '(prefers-color-scheme: light)', '(prefers-reduced-motion: reduce)', '(prefers-reduced-transparency: reduce)', '(forced-colors: active)', '(prefers-contrast: more)', '(pointer: fine)', '(pointer: coarse)', '(hover: hover)', '(any-pointer: coarse)', '(any-hover: hover)', '(color-gamut: p3)', '(dynamic-range: high)', '(resolution: 1dppx)', '(orientation: landscape)', '(display-mode: browser)'];
  const codecs = ['video/mp4; codecs="avc1.42E01E"', 'video/mp4; codecs="hvc1.1.6.L93.B0"', 'video/webm; codecs="vp8"', 'video/webm; codecs="vp09.00.10.08"', 'video/mp4; codecs="av01.0.04M.08"', 'audio/mp4; codecs="mp4a.40.2"', 'audio/mpeg', 'audio/ogg; codecs="opus"', 'audio/wav; codecs="1"'];
  const video = document.createElement('video');
  const limits = ['MAX_TEXTURE_SIZE', 'MAX_CUBE_MAP_TEXTURE_SIZE', 'MAX_RENDERBUFFER_SIZE', 'MAX_VIEWPORT_DIMS', 'MAX_VERTEX_ATTRIBS', 'MAX_VERTEX_UNIFORM_VECTORS', 'MAX_FRAGMENT_UNIFORM_VECTORS', 'MAX_VARYING_VECTORS', 'MAX_COMBINED_TEXTURE_IMAGE_UNITS', 'MAX_VERTEX_TEXTURE_IMAGE_UNITS', 'MAX_TEXTURE_IMAGE_UNITS', 'MAX_3D_TEXTURE_SIZE', 'MAX_ARRAY_TEXTURE_LAYERS', 'MAX_COLOR_ATTACHMENTS', 'MAX_DRAW_BUFFERS', 'MAX_SAMPLES', 'MAX_UNIFORM_BUFFER_BINDINGS', 'MAX_UNIFORM_BLOCK_SIZE', 'MAX_VERTEX_UNIFORM_COMPONENTS', 'MAX_FRAGMENT_UNIFORM_COMPONENTS', 'MAX_TRANSFORM_FEEDBACK_INTERLEAVED_COMPONENTS', 'ALIASED_LINE_WIDTH_RANGE', 'ALIASED_POINT_SIZE_RANGE'];
  const graphics = {};
  for (const kind of ['webgl', 'webgl2']) {
    const gl = document.createElement('canvas').getContext(kind);
    if (!gl) { graphics[kind] = null; continue; }
    graphics[kind] = {limits:Object.fromEntries(limits.filter(name => typeof gl[name] === 'number').map(name => [name, safe(() => {
      const v = gl.getParameter(gl[name]); return ArrayBuffer.isView(v) ? Array.from(v) : v;
    })])), precision:{}};
    for (const shader of ['VERTEX_SHADER', 'FRAGMENT_SHADER']) for (const precision of ['LOW_FLOAT', 'MEDIUM_FLOAT', 'HIGH_FLOAT', 'LOW_INT', 'MEDIUM_INT', 'HIGH_INT']) {
      graphics[kind].precision[`${shader}/${precision}`] = safe(() => { const p = gl.getShaderPrecisionFormat(gl[shader], gl[precision]); return p && {rangeMin:p.rangeMin, rangeMax:p.rangeMax, precision:p.precision}; });
    }
    graphics[kind].error = gl.getError();
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
  return {
    secureContext:isSecureContext,
    navigator:Object.fromEntries(['vendor', 'vendorSub', 'product', 'productSub', 'appName', 'appCodeName', 'cookieEnabled', 'pdfViewerEnabled', 'doNotTrack', 'onLine', 'oscpu', 'buildID'].map(name => [name, safe(() => navigator[name])])),
    plugins:Array.from(navigator.plugins, p => ({name:p.name, filename:p.filename, description:p.description, mimeTypes:Array.from(p, m => ({type:m.type, suffixes:m.suffixes, description:m.description}))})),
    mimeTypes:Array.from(navigator.mimeTypes, m => ({type:m.type, suffixes:m.suffixes, description:m.description})),
    viewport:{innerWidth, innerHeight, outerWidth, outerHeight, screenX, screenY, devicePixelRatio, documentClient:{width:document.documentElement.clientWidth, height:document.documentElement.clientHeight}, visualViewport:{width:visualViewport.width, height:visualViewport.height, scale:visualViewport.scale}},
    navigatorDescriptors:descriptors(Navigator.prototype), screenDescriptors:descriptors(Screen.prototype),
    globalNames:Object.getOwnPropertyNames(window).sort(),
    chrome:safe(() => typeof chrome === 'undefined' ? null : Object.fromEntries(Object.getOwnPropertyNames(chrome).sort().map(k => [k, typeof chrome[k]]))),
    mediaQueries:Object.fromEntries(mediaQueries.map(q => [q, matchMedia(q).matches])),
    codecs:Object.fromEntries(codecs.map(type => [type, {canPlayType:video.canPlayType(type), mediaSource:safe(() => MediaSource.isTypeSupported(type)), recorder:safe(() => MediaRecorder.isTypeSupported(type))}])),
    intl:{date:new Intl.DateTimeFormat().resolvedOptions(), number:new Intl.NumberFormat().resolvedOptions(), collator:new Intl.Collator().resolvedOptions(), fixedDate:new Date('2026-01-15T12:34:56Z').toString()},
    graphics,
    storage:await asyncSafe(() => navigator.storage.estimate()),
    storagePersisted:await asyncSafe(() => navigator.storage.persisted()),
    permissions:Object.fromEntries(await Promise.all(['camera', 'microphone', 'geolocation', 'notifications', 'local-fonts'].map(async name => [name, await asyncSafe(async () => (await navigator.permissions.query({name})).state)]))),
    devices:await asyncSafe(async () => (await navigator.mediaDevices.enumerateDevices()).map(d => d.toJSON())),
    connection:safe(() => navigator.connection && {effectiveType:navigator.connection.effectiveType, rtt:navigator.connection.rtt, downlink:navigator.connection.downlink, saveData:navigator.connection.saveData})
  };
}

const differences = [];
const escape = key => String(key).replaceAll('~', '~0').replaceAll('/', '~1');
function compare(a, b, path = '') {
  if (JSON.stringify(a) === JSON.stringify(b)) return;
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) compare(a[key], b[key], `${path}/${escape(key)}`);
    return;
  }
  const brief = value => Array.isArray(value) ? {kind:'array', length:value.length, sha256:createHash('sha256').update(JSON.stringify(value)).digest('hex'), preview:value.slice(0, 8)} : value === undefined ? {kind:'missing'} : value;
  differences.push({path, iris:brief(a), owl:brief(b)});
}
try {
  for (const name of ['iris', 'owl']) connections[name] = await connect(endpoints[name]);
  const fixture = new URL(connections.iris.url);
  assert(['127.0.0.1', 'localhost', '[::1]', 'iris-owl-parity.localhost'].includes(fixture.hostname), 'Iris 必须已经打开自身 loopback fixture');
  assert(await connections.iris.evaluate('!!window.irisProbe'), '当前 Iris 页面不是共享观测 fixture');
  // 独立 loopback origin 避免 Iris 启动自检已协商 Client Hints、Owl 尚未访问的偏差。
  fixture.hostname = 'iris-owl-parity.localhost';
  for (const name of ['iris', 'owl']) {
    const session = connections[name];
    const engine = await session.send('Browser.getVersion');
    let permission;
    try { await session.send('Browser.setPermission', {permission:{name:'local-fonts'}, setting:'granted', origin:fixture.origin}); permission = {requestAccepted:true, origin:fixture.origin}; }
    catch (error) { permission = {requestAccepted:false, origin:fixture.origin, error:error.message}; }
    await session.send('Page.bringToFront');
    await session.navigate(fixture.href);
    assert(await session.evaluate('!!window.irisProbe'), '主文档加载后缺少 fixture Promise');
    const report = await session.evaluate('Promise.race([window.irisProbe, new Promise((_, reject) => setTimeout(() => reject(new Error("fixture deadline exceeded")), 35000))])');
    const extra = await session.evaluate(`(${supplemental.toString()})()`);
    permission.observedState = extra.permissions['local-fonts'];
    const layout = await session.send('Page.getLayoutMetrics');
    const screenshot = await session.send('Page.captureScreenshot', {format:'png'});
    const png = Buffer.from(screenshot.data, 'base64');
    assert(png.length >= 24 && png.toString('hex', 0, 8) === '89504e470d0a1a0a' && png.toString('ascii', 12, 16) === 'IHDR', '截图不是有效的 PNG 头');
    const screenshotSize = {width:png.readUInt32BE(16), height:png.readUInt32BE(20)};
    reports[name] = {endpoint:endpoints[name], fixture:fixture.href, engine, permission, report, supplemental:extra, layout, screenshotSize};
    await writeFile(join(output, `${name}.json`), JSON.stringify(reports[name], null, 2));
    await writeFile(join(output, `${name}.png`), png);
    if (report.fatal) failures.push({browser:name, group:'fixture', error:report.fatal});
    if (layout.cssLayoutViewport.clientWidth <= 0 || layout.cssLayoutViewport.clientHeight <= 0) {
      failures.push({browser:name, group:'surface', error:'实际布局视口为空；请还原最小化窗口或使用无窗口会话后重测。'});
    }
    for (const [group, value] of Object.entries(report.raw ?? {})) if (value?.error || value?.timeout) failures.push({browser:name, group, result:value});
    for (const [context, value] of Object.entries(report.raw?.contexts?.contexts ?? {})) {
      if (value?.error || value?.timeout) failures.push({browser:name, group:`contexts/${context}`, result:value});
    }
    console.log(`${name}: ${engine.product}; ${Object.keys(report.raw ?? {}).length} raw groups; reported=${extra.viewport.innerWidth}x${extra.viewport.innerHeight}; png=${screenshotSize.width}x${screenshotSize.height}; layout=${layout.cssLayoutViewport.clientWidth}x${layout.cssLayoutViewport.clientHeight}`);
  }
  compare({engine:reports.iris.engine, raw:reports.iris.report.raw, supplemental:reports.iris.supplemental, layout:reports.iris.layout, screenshotSize:reports.iris.screenshotSize}, {engine:reports.owl.engine, raw:reports.owl.report.raw, supplemental:reports.owl.supplemental, layout:reports.owl.layout, screenshotSize:reports.owl.screenshotSize});
  const result = {schema:'iris-owl-observables/1', equal:differences.length === 0 && failures.length === 0, differenceCount:differences.length, failures,
    notes:['数组比较完整 JSON；预览只显示前八项，全部数据保留在原始报告。', '动态时间、nonce、URL、存储量和实际窗口尺寸均保留，尚未归因为缺陷。', 'fixture 的 checks 和 expectations 只针对 Iris，不参与双方一致性判定。', '已确认的参考缺陷例外：保留真实编解码能力声明，不复制 Owl 的支持声明与实际操作矛盾；保留已指定时区，不复制 Owl 在 worker 终止后重置主窗口时区的副作用。差异仍完整计数，不静默忽略。', '本报告覆盖现有 fixture 与补充 API；不宣称穷尽 Web API、TLS/HTTP2 指纹或外部站点检测。'], differences};
  await writeFile(join(output, 'comparison.json'), JSON.stringify(result, null, 2));
  console.log(`differences=${differences.length}; collectionFailures=${failures.length}; output=${output}`);
  if (failures.length) process.exitCode = 2;
  else if (differences.length) process.exitCode = 1;
} catch (error) {
  console.error(error);
  process.exitCode = 2;
} finally {
  for (const connection of Object.values(connections)) await connection.close();
}
