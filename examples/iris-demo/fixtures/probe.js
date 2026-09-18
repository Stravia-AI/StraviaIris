/* iris-demo probe.js：真实浏览器行为测量工具。window.irisProbe 为 Promise，resolve
   原始报告 { fixture, startedAt, page, expectations, raw, checks, cleanup }。
   原则：
   - 只测量，不注入/篡改任何 getter，不预置展示值；
   - 每个测量组独立捕获异常与超时（有界等待，超时即失败，不重试不轮询）；
   - checks 只对实际执行并成功观察到的行为判 true；未运行/不支持一律 false 并保留证据；
   - 预期值（expectations）仅用于 check，与 raw 原始数据分开存放。 */
(function () {
'use strict';

var CANVAS_W = 64, CANVAS_H = 48;
var HIGH_ENTROPY_KEYS = ['architecture', 'bitness', 'model', 'platformVersion',
                         'uaFullVersion', 'fullVersionList', 'wow64'];

/* 预期输入（profile 相关的期望，仅用于 checks，与 raw 分开） */
var EXPECTATIONS = {
  allowedFamilies: ['Arial', 'Arial Black', 'Bahnschrift', 'Calibri', 'Cambria', 'Cambria Math',
                    'Cascadia Code', 'Comic Sans MS', 'Consolas', 'Constantia', 'Corbel', 'Courier New',
                    'Franklin Gothic', 'Franklin Gothic Medium', 'Gabriola', 'Gadugi', 'Georgia', 'Impact',
                    'Ink Free', 'Leelawadee UI', 'Lucida Console', 'Lucida Sans Unicode', 'MS Gothic',
                    'MS PGothic', 'MS UI Gothic', 'Malgun Gothic', 'Marlett', 'Microsoft Sans Serif',
                    'Microsoft YaHei', 'Nirmala UI', 'Palatino Linotype', 'Segoe UI', 'Segoe UI Emoji',
                    'Segoe UI Light', 'Segoe UI Symbol', 'SimSun', 'Symbol', 'Tahoma', 'Times New Roman',
                    'Trebuchet MS', 'Verdana', 'Webdings', 'Yu Gothic'],
  nonUniqueLocalFamilies: ['Franklin Gothic', 'Yu Gothic'],
  installedDisallowedCandidates: ['Wingdings', 'Microsoft YaHei UI', 'SimHei', 'DengXian',
                                  'NSimSun', 'Microsoft JhengHei'],
  webFont: { family: 'IrisAhem', url: '/fonts/Ahem.ttf', advanceEmPerGlyph: 1 },
  offlineAudio: { channels: 1, length: 44100, requestedSampleRate: 44100,
                  sampleRate: 48000, duration: 44100 / 48000 },
  float16InputBits: [0x0401, 0x1001, 0x3001, 0x3c00]
};

/* ------------------------------ 基础工具 ------------------------------ */

function withTimeout(promise, ms, label) {
  return new Promise(function (resolve, reject) {
    var timer = setTimeout(function () {
      reject(new Error('timeout:' + label + ':' + ms + 'ms'));
    }, ms);
    Promise.resolve(promise).then(
      function (v) { clearTimeout(timer); resolve(v); },
      function (e) { clearTimeout(timer); reject(e); }
    );
  });
}

function hexOf(buffer) {
  var bytes = new Uint8Array(buffer);
  var out = [];
  for (var i = 0; i < bytes.length; i++) out.push(bytes[i].toString(16).padStart(2, '0'));
  return out.join('');
}

function sha256Hex(buffer) {
  return crypto.subtle.digest('SHA-256', buffer).then(hexOf);
}

/* 用 ImageDecoder + VideoFrame.copyTo 取得 PNG 序列化后的原始像素，不经过任何
   canvas getImageData 二次路径（避免引入另一噪声 domain / 二次扰动）。 */
function decodePngRaw(buffer) {
  if (typeof ImageDecoder !== 'function' || typeof VideoFrame !== 'function')
    return Promise.resolve({ supported: false, reason: 'ImageDecoder/VideoFrame 不可用' });
  var decoder = null;
  try {
    decoder = new ImageDecoder({ data: buffer, type: 'image/png', colorSpaceConversion: 'none' });
  } catch (e) {
    return Promise.resolve({ supported: false, error: String(e && e.message || e) });
  }
  return decoder.decode({ frameIndex: 0 }).then(function (result) {
    var frame = result.image;
    var info = { supported: true, format: frame.format,
                 displayWidth: frame.displayWidth, displayHeight: frame.displayHeight };
    var release = function () { try { frame.close(); } catch (e2) {} try { decoder.close(); } catch (e3) {} };
    try {
      var size = frame.allocationSize();
      var bytes = new Uint8Array(size);
      return frame.copyTo(bytes).then(function () {
        release();
        info.byteLength = size;
        info.bytes = bytes;
        return sha256Hex(rgbaOfRaw(bytes, info.format,
          info.displayWidth * info.displayHeight).buffer).then(function (digest) {
          info.rgbaDigest = digest;
          return info;
        });
      }, function (e) { release(); info.error = 'copyTo 失败: ' + String(e && e.message || e); return info; });
    } catch (e) { release(); info.error = 'allocationSize/copyTo 失败: ' + String(e && e.message || e); return info; }
  }, function (e) {
    try { decoder.close(); } catch (e2) {}
    return { supported: true, error: 'decode 失败: ' + String(e && e.message || e) };
  });
}

/* WebCodecs PNG 解码使用非预乘 alpha。只正规化通道序和无 alpha 格式的
   不透明语义，不跳过半透明像素，也不再经过 Canvas 读回。 */
function rgbaOfRaw(rawBytes, format, pixelCount) {
  var lower = String(format || '');
  if (!/^(RGBA|BGRA|RGBX|BGRX|RGB|BGR)$/.test(lower))
    throw new Error('无法比较原生像素格式: ' + lower);
  var channels = /^(RGB|BGR)$/.test(lower) ? 3 : 4;
  if (rawBytes.length !== pixelCount * channels)
    throw new Error('原始像素长度与尺寸不符');
  if (lower === 'RGBA') return rawBytes;
  var swap = lower.indexOf('BGRA') === 0 || lower.indexOf('BGR') === 0;
  var out = new Uint8Array(pixelCount * 4);
  for (var i = 0; i < pixelCount; i++) {
    var s = i * channels, o = i * 4;
    if (swap) {
      out[o] = rawBytes[s + 2]; out[o + 1] = rawBytes[s + 1]; out[o + 2] = rawBytes[s];
    } else {
      out[o] = rawBytes[s]; out[o + 1] = rawBytes[s + 1]; out[o + 2] = rawBytes[s + 2];
    }
    out[o + 3] = lower === 'BGRA' ? rawBytes[s + 3] : 255;
  }
  return out;
}

function rawVsTarget(rawInfo, target, pixelCount) {
  if (!rawInfo || rawInfo.supported !== true || !rawInfo.bytes)
    return { error: rawInfo && (rawInfo.error || rawInfo.reason) || 'raw 解码不可用' };
  var rgba = rgbaOfRaw(rawInfo.bytes, rawInfo.format, pixelCount);
  if (target.length !== pixelCount * 4)
    return { error: '比较目标长度与尺寸不符' };
  var hard = 0, first = null;
  for (var i = 0; i < pixelCount; i++) {
    var o = i * 4;
    for (var ch = 0; ch < 4; ch++) {
      if (rgba[o + ch] !== target[o + ch]) {
        hard++;
        if (!first) first = { pixel: i, channel: ch, got: rgba[o + ch], want: target[o + ch] };
      }
    }
  }
  return { hardMismatches: hard, pixelsCompared: pixelCount,
           alphaCompared: true, firstDiff: first };
}


function bytesEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function firstDiff(a, b) {
  var n = Math.min(a.length, b.length);
  for (var i = 0; i < n; i++) if (a[i] !== b[i]) return { index: i, a: a[i], b: b[i] };
  return null;
}

function f32Bits(value) { return new Uint32Array(new Float32Array([value]).buffer)[0]; }

/* 从按行存储的字节缓冲提取区域（readPixels 行序为自底向上，与写入一致） */
function extractRows(src, rowStride, rowStart, colStart, pixelsPerRow, rows, channels) {
  var out = new Uint8Array(pixelsPerRow * rows * channels);
  var o = 0;
  for (var r = 0; r < rows; r++) {
    var base = (rowStart + r) * rowStride + colStart * channels;
    for (var c = 0; c < pixelsPerRow * channels; c++) out[o++] = src[base + c];
  }
  return out;
}

function domReady() {
  if (document.readyState === 'interactive' || document.readyState === 'complete')
    return Promise.resolve();
  return new Promise(function (resolve) {
    document.addEventListener('DOMContentLoaded', function () { resolve(); }, { once: true });
  });
}

/* ------------------------------ 身份采样（window） ------------------------------ */

function timezoneSample() {
  var winter = new Date('2026-01-15T12:00:00Z');
  var summer = new Date('2026-07-15T12:00:00Z');
  var fmt = null;
  try { fmt = new Intl.DateTimeFormat('en-US', { timeZoneName: 'longOffset' }); } catch (e) {}
  var resolved = null;
  try { resolved = fmt && fmt.resolvedOptions().timeZone; } catch (e) {}
  return {
    offsetWinterMinutes: winter.getTimezoneOffset(),
    offsetSummerMinutes: summer.getTimezoneOffset(),
    resolvedTimeZone: resolved === undefined ? null : resolved,
    formattedWinter: fmt ? fmt.format(winter) : null,
    formattedSummer: fmt ? fmt.format(summer) : null,
    localString: winter.toString()
  };
}

function coreSample(contextKind) {
  var n = navigator;
  return {
    contextKind: contextKind,
    href: (typeof location !== 'undefined' && location.href) || null,
    userAgent: typeof n.userAgent === 'string' ? n.userAgent : null,
    appVersion: typeof n.appVersion === 'string' ? n.appVersion : null,
    platform: typeof n.platform === 'string' ? n.platform : null,
    language: typeof n.language === 'string' ? n.language : null,
    languages: Array.isArray(n.languages) ? Array.from(n.languages) : null,
    hardwareConcurrency: typeof n.hardwareConcurrency === 'number' ? n.hardwareConcurrency : null,
    deviceMemory: typeof n.deviceMemory === 'number' ? n.deviceMemory : null,
    maxTouchPoints: typeof n.maxTouchPoints === 'number' ? n.maxTouchPoints : null,
    webdriver: {
      typeofValue: typeof n.webdriver,
      value: n.webdriver === undefined ? null : n.webdriver,
      present: 'webdriver' in n
    },
    userAgentData: n.userAgentData ? {
      brands: n.userAgentData.brands.map(function (b) { return [b.brand, b.version]; }),
      mobile: n.userAgentData.mobile,
      platform: n.userAgentData.platform
    } : null
  };
}

function highEntropySample() {
  if (!navigator.userAgentData)
    return Promise.resolve({ supported: false, error: 'userAgentData 不存在', values: null });
  return navigator.userAgentData.getHighEntropyValues(HIGH_ENTROPY_KEYS).then(
    function (high) { return { supported: true, error: null, values: JSON.parse(JSON.stringify(high)) }; },
    function (err) { return { supported: true, error: String(err && err.message || err), values: null }; }
  );
}

/* 与 worker.js 的 drawOps 逐字节一致 */
function drawOps(ctx) {
  var g = ctx.createLinearGradient(0, 0, CANVAS_W, CANVAS_H);
  g.addColorStop(0, '#010203');
  g.addColorStop(1, '#fefcff');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
  ctx.strokeStyle = '#c0182f';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(4, 44);
  ctx.lineTo(60, 4);
  ctx.stroke();
  ctx.fillStyle = '#1050e0';
  ctx.beginPath();
  ctx.arc(32, 24, 9, 0, Math.PI * 2);
  ctx.fill();
  ctx.clearRect(50, 34, 10, 10);
  ctx.fillStyle = 'rgba(200,120,40,0.55)';
  ctx.fillRect(50, 34, 10, 10);
  ctx.font = '16px monospace';
  ctx.fillStyle = '#101010';
  ctx.fillText('Iris 123', 3, 16);
}

/* ------------------------------ 资源登记（供清理） ------------------------------ */

var resources = { workers: [], sharedPorts: [], iframes: [], audioContexts: [],
                  glContexts: [], blobUrls: [], serviceWorker: null };

/* ------------------------------ contexts 组 ------------------------------ */

function identityValueOf(sample, field) {
  if (!sample) return null;
  var he = sample.highEntropy && sample.highEntropy.values;
  switch (field) {
    case 'uaBrands':
      return sample.userAgentData && sample.userAgentData.brands
        ? JSON.stringify(sample.userAgentData.brands.slice().sort()) : null;
    case 'uaMobile':
      return sample.userAgentData ? sample.userAgentData.mobile : null;
    case 'uaPlatform':
      return sample.userAgentData ? sample.userAgentData.platform : null;
    case 'webdriverPresent':
      return sample.webdriver ? sample.webdriver.present : null;
    default:
      if (field.indexOf('he_') === 0) {
        if (!he) return null;
        var key = field.slice(3);
        var v = he[key];
        if (v === undefined) return null;
        if (Array.isArray(v)) {
          return JSON.stringify(v.map(function (e) {
            return Array.isArray(e) ? [e.brand, e.version].join('=') : String(e);
          }).sort());
        }
        return typeof v === 'object' && v !== null ? JSON.stringify(v) : v;
      }
      return sample[field] === undefined ? null : sample[field];
  }
}

var IDENTITY_FIELDS = ['userAgent', 'appVersion', 'platform', 'language', 'languages',
  'hardwareConcurrency', 'deviceMemory', 'maxTouchPoints', 'webdriverPresent',
  'uaBrands', 'uaMobile', 'uaPlatform', 'he_architecture', 'he_bitness', 'he_model',
  'he_platformVersion', 'he_uaFullVersion', 'he_fullVersionList', 'he_wow64'];

function contextsGroup() {
  var token = Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  var crossOrigin = 'http://localhost:' + location.port;
  var listeners = [];

  function waitContextIframe(kind, src, expectedOrigin, timeoutMs) {
    return new Promise(function (resolve) {
      var host = document.getElementById('iframe-host');
      var iframe = document.createElement('iframe');
      iframe.id = 'iris-iframe-' + kind;
      iframe.title = kind === 'same' ? '同源 iframe 测量点' : '跨站 iframe（localhost）测量点';
      iframe.style.cssText = 'width:480px;height:140px;border:1px dashed #8888;background:#8881';
      iframe.src = src;
      resources.iframes.push(iframe);
      var record = { kind: kind, expectedOrigin: expectedOrigin, src: src,
                     loaded: false, invalidMessages: [], validation: null, sample: null };
      iframe.addEventListener('load', function () { record.loaded = true; });
      iframe.addEventListener('error', function () { record.loadError = true; });
      var settle = function (result) { record.done = true; resolve(result); };
      var handler = function (event) {
        var data = event.data;
        if (!data || data.iris !== 'iris-context-report' || data.kind !== kind || record.done)
          return;
        var validation = {
          sourceMatches: event.source === iframe.contentWindow,
          originMatches: event.origin === expectedOrigin,
          tokenMatches: typeof data.token === 'string' && data.token === token
        };
        if (validation.sourceMatches && validation.originMatches && validation.tokenMatches) {
          record.validation = validation;
          record.sample = data.sample;
          record.reportedOrigin = data.origin;
          record.wildcardTargetOrigin = data.wildcardTargetOrigin === true;
          settle(record);
        } else {
          record.invalidMessages.push({ validation: validation, eventOrigin: event.origin });
        }
      };
      window.addEventListener('message', handler);
      listeners.push(handler);
      host.appendChild(iframe);
      // 跨站帧离屏时可能被渲染节流；测量可见、已布局的表面，而非初始化的 0×0。
      host.scrollIntoView({ block: 'center' });
      setTimeout(function () {
        if (!record.done) { record.timeout = true; settle(record); }
      }, timeoutMs);
    });
  }

  function waitWorker(kind, timeoutMs) {
    return new Promise(function (resolve) {
      var nonce = kind + '-' + token.slice(0, 8);
      var record = { kind: kind, nonce: nonce, validation: null, report: null };
      var settle = function () { record.done = true; resolve(record); };
      if (kind === 'dedicated') {
        var w = null;
        try { w = new Worker('/worker.js'); } catch (e) { record.error = String(e && e.message || e); return settle(); }
        resources.workers.push(w);
        w.onmessage = function (event) {
          var d = event.data;
          if (d && d.iris === 'iris-worker-report' && d.nonce === nonce) {
            record.validation = { nonceMatches: true, originReceived: event.origin };
            record.report = d.report;
            settle();
          } else if (d && d.iris === 'iris-worker-error' && d.nonce === nonce) {
            record.validation = { nonceMatches: true, originReceived: event.origin };
            record.error = d.error;
            settle();
          }
        };
        w.onerror = function (e) { record.error = 'worker error: ' + (e.message || 'unknown'); settle(); };
        w.postMessage({ iris: 'iris-worker-request', nonce: nonce });
      } else {
        var sw = null;
        try { sw = new SharedWorker('/worker.js'); } catch (e) { record.error = String(e && e.message || e); return settle(); }
        resources.sharedPorts.push(sw.port);
        sw.port.onmessage = function (event) {
          var d = event.data;
          if (d && d.iris === 'iris-worker-report' && d.nonce === nonce) {
            record.validation = { nonceMatches: true, originReceived: event.origin };
            record.report = d.report;
            settle();
          } else if (d && d.iris === 'iris-worker-error' && d.nonce === nonce) {
            record.validation = { nonceMatches: true, originReceived: event.origin };
            record.error = d.error;
            settle();
          }
        };
        sw.onerror = function (e) { record.error = 'shared worker error: ' + (e.message || 'unknown'); settle(); };
        sw.port.start();
        sw.port.postMessage({ iris: 'iris-worker-request', nonce: nonce });
      }
      setTimeout(function () { if (!record.done) { record.timeout = true; settle(); } }, timeoutMs);
    });
  }

  function waitServiceWorker(timeoutMs) {
    return Promise.resolve().then(function () {
      return withTimeout(window.irisSwRegistration, 10000, 'sw-register');
    }).then(function (reg) {
      resources.serviceWorker = reg;
      return withTimeout(navigator.serviceWorker.ready, 10000, 'sw-ready').then(function (ready) {
        return { reg: reg, sw: ready.active || reg.active };
      });
    }).then(function (info) {
      return new Promise(function (resolve) {
        var nonce = 'sw-' + token.slice(0, 8);
        var record = { kind: 'service-worker', nonce: nonce, validation: null, report: null };
        var settle = function () {
          navigator.serviceWorker.removeEventListener('message', handler);
          record.done = true;
          resolve(record);
        };
        var handler = function (event) {
          var d = event.data;
          if (!d || (d.iris !== 'iris-sw-report' && d.iris !== 'iris-sw-error') || d.nonce !== nonce)
            return;
          record.validation = {
            nonceMatches: true,
            originMatches: event.origin === location.origin,
            sourceMatches: event.source === info.sw,
            originReceived: event.origin
          };
          if (d.iris === 'iris-sw-report') record.report = d.report;
          else record.error = d.error;
          settle();
        };
        navigator.serviceWorker.addEventListener('message', handler);
        if (!info.sw) { record.error = 'service worker 未激活'; return settle(); }
        info.sw.postMessage({ iris: 'iris-sw-request', nonce: nonce });
        setTimeout(function () { if (!record.done) { record.timeout = true; settle(); } }, timeoutMs);
      });
    });
  }

  var windowSamplePromise = highEntropySample().then(function (he) {
    var s = coreSample('window');
    s.highEntropy = he;
    s.timezone = timezoneSample();
    return s;
  });

  var samePromise = waitContextIframe('same', '/context.html?iris=same#t=' + token, location.origin, 12000);
  var crossPromise = waitContextIframe('cross', crossOrigin + '/context.html?iris=cross#t=' + token,
                                       crossOrigin, 12000);
  var dedPromise = waitWorker('dedicated', 10000);
  var sharedPromise = waitWorker('shared', 10000);
  var swPromise = waitServiceWorker(8000).catch(function (err) {
    return { kind: 'service-worker', error: String(err && err.message || err), timeout: /timeout/.test(String(err)) };
  });

  return Promise.all([windowSamplePromise, samePromise, crossPromise, dedPromise, sharedPromise, swPromise])
    .then(function (results) {
      listeners.forEach(function (h) { window.removeEventListener('message', h); });
      var contexts = {
        window: results[0],
        sameOriginIframe: results[1].timeout ? { timeout: true, invalidMessages: results[1].invalidMessages } : results[1],
        crossSiteIframe: results[2].timeout ? { timeout: true, invalidMessages: results[2].invalidMessages } : results[2],
        dedicatedWorker: results[3],
        sharedWorker: results[4],
        serviceWorker: results[5]
      };
      function sampleOf(context) {
        if (!context || context.timeout || context.error) return null;
        if (context.sample) return context.sample;
        return context.report || null;
      }
      var matrix = {};
      var keys = ['sameOriginIframe', 'crossSiteIframe', 'dedicatedWorker', 'sharedWorker', 'serviceWorker'];
      var present = [{ key: 'window', sample: contexts.window }];
      keys.forEach(function (k) { var s = sampleOf(contexts[k]); if (s) present.push({ key: k, sample: s }); });
      IDENTITY_FIELDS.forEach(function (field) {
        var entry = { values: {}, supported: {}, note: null };
        var reference = null, hasReference = false, equal = true;
        present.forEach(function (ctx) {
          var v = identityValueOf(ctx.sample, field);
          entry.values[ctx.key] = v === null || v === undefined ? null : v;
          entry.supported[ctx.key] = v !== null && v !== undefined;
          if (!entry.supported[ctx.key]) return;
          var serialized = typeof v === 'object' ? JSON.stringify(v) : v;
          if (!hasReference) { reference = serialized; hasReference = true; }
          else if (serialized !== reference) equal = false;
        });
        entry.equal = hasReference ? equal : null;
        if (present.length < 2) entry.note = '可用上下文不足（' + present.length + '）';
        matrix[field] = entry;
      });
      return { contexts: contexts, identityMatrix: matrix, availableContexts: present.map(function (p) { return p.key; }) };
    });
}

/* ------------------------------ timezone / screen 组 ------------------------------ */

function timezoneGroup() {
  return Promise.resolve().then(function () {
    var sample = timezoneSample();
    sample.transitions = {
      marchNextDay: new Date('2026-03-29T01:00:00Z').getTimezoneOffset(),
      octoberNextDay: new Date('2026-10-25T01:00:00Z').getTimezoneOffset()
    };
    sample.intlFormatterSample = new Intl.DateTimeFormat('zh-CN', {
      dateStyle: 'full', timeStyle: 'long'
    }).format(new Date('2026-07-15T12:00:00Z'));
    return sample;
  });
}

function screenGroup() {
  return Promise.resolve().then(function () {
    var s = screen, so = s.orientation;
    var dpr = window.devicePixelRatio;
    var rounded = Math.round(dpr * 8) / 8;
    var queries = {};
    try { queries.orientationLandscape = matchMedia('(orientation: landscape)').matches; } catch (e) { queries.orientationLandscape = null; }
    try {
      queries.resolution = {
        query: '(resolution: ' + rounded + 'dppx)', matches: matchMedia('(resolution: ' + rounded + 'dppx)').matches
      };
    } catch (e) { queries.resolution = null; }
    try { queries.colorGamutP3 = matchMedia('(color-gamut: p3)').matches; } catch (e) { queries.colorGamutP3 = null; }
    try { queries.colorGamutRec2020 = matchMedia('(color-gamut: rec2020)').matches; } catch (e) { queries.colorGamutRec2020 = null; }
    try { queries.color8Bit = matchMedia('(color: 8)').matches; } catch (e) { queries.color8Bit = null; }
    try { queries.color10Bit = matchMedia('(color: 10)').matches; } catch (e) { queries.color10Bit = null; }
    try { queries.prefersColorSchemeDark = matchMedia('(prefers-color-scheme: dark)').matches; } catch (e) { queries.prefersColorSchemeDark = null; }
    try { queries.prefersReducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { queries.prefersReducedMotion = null; }
    try { queries.dynamicRange = matchMedia('(dynamic-range: high)').matches; } catch (e) { queries.dynamicRange = null; }
    return {
      width: s.width, height: s.height,
      availWidth: s.availWidth, availHeight: s.availHeight,
      availLeft: s.availLeft, availTop: s.availTop,
      colorDepth: s.colorDepth, pixelDepth: s.pixelDepth,
      isExtended: s.isExtended === undefined ? null : s.isExtended,
      devicePixelRatio: dpr,
      orientation: so ? { type: so.type, angle: so.angle } : null,
      viewport: { innerWidth: innerWidth, innerHeight: innerHeight,
                  outerWidth: outerWidth, outerHeight: outerHeight,
                  screenX: screenX, screenY: screenY },
      visualViewport: window.visualViewport ? {
        width: visualViewport.width, height: visualViewport.height,
        scale: visualViewport.scale
      } : null,
      documentClient: {
        width: document.documentElement.clientWidth,
        height: document.documentElement.clientHeight
      },
      matchMedia: queries
    };
  });
}

/* ------------------------------ WebGL 组 ------------------------------ */

// 采用 UNORM8 的整数色阶，避免驱动对半阶 clear 值的舍入和抖动混入 ±1 位测量。
var QUAD_COLORS = [[64/255, 128/255, 192/255], [1, 0, 128/255],
                   [32/255, 16/255, 8/255], [128/255, 64/255, 224/255]];

async function transferredWebglGroup() {
  var output = {};
  for (var kind of ['webgl', 'webgl2']) {
    var canvas = document.createElement('canvas');
    canvas.width = 8; canvas.height = 8;
    document.body.appendChild(canvas);
    var worker = new Worker('/worker.js');
    resources.workers.push(worker);
    try {
      var response = new Promise(function (resolve, reject) {
        worker.onmessage = function (event) {
          if (event.data && event.data.iris === 'iris-transfer-report') resolve(event.data);
        };
        worker.onerror = function (event) { reject(new Error(event.message)); };
      });
      var transferred = canvas.transferControlToOffscreen();
      worker.postMessage({ iris: 'iris-transfer-webgl', kind: kind, canvas: transferred }, [transferred]);
      var result = await withTimeout(response, 8000, 'transferred ' + kind);
      if (result.error !== 0) throw new Error('worker WebGL: ' + result.error);
      await new Promise(requestAnimationFrame);
      var blob = await new Promise(function (resolve) { canvas.toBlob(resolve, 'image/png'); });
      if (!blob) throw new Error('placeholder toBlob 返回 null');
      var pixels = new Uint8Array(8 * 8 * 4);
      for (var row = 0; row < 8; row++) pixels.set(result.pixels.subarray((7 - row) * 32, (8 - row) * 32), row * 32);
      var placeholder = await decodePngRaw(await blob.arrayBuffer());
      var workerPng = await decodePngRaw(result.png);
      output[kind] = {
        attributes: result.attributes, error: result.error,
        sample: Array.from(pixels.subarray(0, 4)), digest: await sha256Hex(pixels.buffer),
        pixels: Array.from(pixels),
        placeholderPixels: Array.from(rgbaOfRaw(placeholder.bytes, placeholder.format, 64)),
        placeholderFormat: placeholder.format,
        placeholder: rawVsTarget(placeholder, pixels, 64),
        workerPng: rawVsTarget(workerPng, pixels, 64),
        alphaPreserved: pixels.every(function (v, i) { return i % 4 !== 3 || v === 128; })
      };
    } finally {
      canvas.remove();
    }
  }
  return output;
}

function webglGroup() {
  return Promise.resolve().then(function () {
    var out = { webgl1: null, webgl2: null, readback: null, buffers: null, errors: null };
    var canvas1 = document.createElement('canvas');
    canvas1.width = CANVAS_W; canvas1.height = CANVAS_H;
    var gl1 = canvas1.getContext('webgl', { antialias: false, alpha: false });
    var canvas2 = document.createElement('canvas');
    canvas2.width = CANVAS_W; canvas2.height = CANVAS_H;
    var gl2 = canvas2.getContext('webgl2', { antialias: false, alpha: false });

    function identitySnapshot(gl, label) {
      if (!gl) return { supported: false, error: 'getContext(' + label + ') 返回 null' };
      var ext = gl.getExtension('WEBGL_debug_renderer_info');
      function str(pname) {
        try { var v = gl.getParameter(pname); return typeof v === 'string' ? v : String(v); }
        catch (e) { return null; }
      }
      var snap = {
        supported: true, label: label,
        debugRendererInfoAvailable: !!ext,
        vendor: str(gl.VENDOR), renderer: str(gl.RENDERER), version: str(gl.VERSION),
        shadingLanguageVersion: str(gl.SHADING_LANGUAGE_VERSION),
        unmaskedVendor: ext ? str(ext.UNMASKED_VENDOR_WEBGL) : null,
        unmaskedRenderer: ext ? str(ext.UNMASKED_RENDERER_WEBGL) : null,
        maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
        maxRenderbufferSize: gl.getParameter(gl.MAX_RENDERBUFFER_SIZE),
        maxViewportDims: Array.from(gl.getParameter(gl.MAX_VIEWPORT_DIMS) || []),
        aliasedLineWidthRange: Array.from(gl.getParameter(gl.ALIASED_LINE_WIDTH_RANGE) || []),
        maxVertexAttribs: gl.getParameter(gl.MAX_VERTEX_ATTRIBS),
        maxCombinedTextureImageUnits: gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS),
        maxTextureImageUnits: gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS),
        implementationColorReadFormat: gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_FORMAT),
        implementationColorReadType: gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_TYPE),
        contextAttributes: gl.getContextAttributes(),
        extensions: gl.getSupportedExtensions()
      };
      return snap;
    }

    function scissoredClear(gl, x, y, w, h, rgb) {
      gl.scissor(x, y, w, h);
      gl.clearColor(rgb[0], rgb[1], rgb[2], 1.0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    function paintQuadrants(gl) {
      gl.disable(gl.SCISSOR_TEST);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.SCISSOR_TEST);
      scissoredClear(gl, 0, 0, 32, 24, QUAD_COLORS[0]);
      scissoredClear(gl, 32, 0, 32, 24, QUAD_COLORS[1]);
      scissoredClear(gl, 0, 24, 32, 24, QUAD_COLORS[2]);
      scissoredClear(gl, 32, 24, 32, 24, QUAD_COLORS[3]);
      gl.disable(gl.SCISSOR_TEST);
    }
    function expectedColor(x, y) {
      var qx = x < 32 ? 0 : 1, qy = y < 24 ? 0 : 1;
      var c = QUAD_COLORS[qy * 2 + qx];
      return [Math.round(c[0] * 255), Math.round(c[1] * 255), Math.round(c[2] * 255), 255];
    }
    function toleranceCheck(bytes, x0, y0, w, h) {
      var maxDelta = 0, beyond = 0;
      for (var y = 0; y < h; y++) {
        for (var x = 0; x < w; x++) {
          var i = (y * w + x) * 4;
          var e = expectedColor(x0 + x, y0 + y);
          for (var ch = 0; ch < 3; ch++) {
            var d = Math.abs(bytes[i + ch] - e[ch]);
            if (d > maxDelta) maxDelta = d;
            if (d > 1) beyond++;
          }
        }
      }
      return { maxDelta: maxDelta, beyondTolerance: beyond };
    }
    function drainErrors(gl) {
      var count = 0, last = 0;
      for (var i = 0; i < 10; i++) {
        var e = gl.getError();
        if (e === gl.NO_ERROR) break;
        last = e; count++;
      }
      return { count: count, last: last };
    }

    out.webgl1 = identitySnapshot(gl1, 'webgl');
    out.webgl2 = identitySnapshot(gl2, 'webgl2');

    /* webgl1 基础读回 */
    if (gl1) {
      paintQuadrants(gl1);
      var b = new Uint8Array(CANVAS_W * CANVAS_H * 4);
      gl1.readPixels(0, 0, CANVAS_W, CANVAS_H, gl1.RGBA, gl1.UNSIGNED_BYTE, b);
      out.webgl1.clearRoundtrip = toleranceCheck(b, 0, 0, CANVAS_W, CANVAS_H);
      out.webgl1.clearRoundtripDigest = null;
    }

    if (gl2) {
      paintQuadrants(gl2);
      var readback = out.readback = {};
      var full = new Uint8Array(CANVAS_W * CANVAS_H * 4);
      gl2.readPixels(0, 0, CANVAS_W, CANVAS_H, gl2.RGBA, gl2.UNSIGNED_BYTE, full);
      var cropA = new Uint8Array(32 * 24 * 4);
      gl2.readPixels(16, 8, 32, 24, gl2.RGBA, gl2.UNSIGNED_BYTE, cropA);
      var cropB = new Uint8Array(32 * 24 * 4);
      gl2.readPixels(16, 8, 32, 24, gl2.RGBA, gl2.UNSIGNED_BYTE, cropB);
      var fromFull = extractRows(full, CANVAS_W * 4, 8, 16, 32, 24, 4);
      readback.fullDigest = null; /* 稍后统一填 */
      readback.cropMatchesFull = bytesEqual(cropA, fromFull);
      readback.cropFirstDiff = firstDiff(cropA, fromFull);
      readback.repeatIdentical = bytesEqual(cropA, cropB);
      readback.clearTolerance = toleranceCheck(cropA, 16, 8, 32, 24);
      readback.sampleBytes = Array.from(cropA.slice(0, 8));

      /* PBO 基本读回 == typed-array 读回 */
      var cropLen = 32 * 24 * 4;
      var pbo = gl2.createBuffer();
      gl2.bindBuffer(gl2.PIXEL_PACK_BUFFER, pbo);
      gl2.bufferData(gl2.PIXEL_PACK_BUFFER, cropLen, gl2.STREAM_READ);
      gl2.readPixels(16, 8, 32, 24, gl2.RGBA, gl2.UNSIGNED_BYTE, 0);
      var pboView = new Uint8Array(cropLen);
      gl2.getBufferSubData(gl2.PIXEL_PACK_BUFFER, 0, pboView);
      readback.pboMatchesTyped = bytesEqual(pboView, cropA);
      readback.pboFirstDiff = firstDiff(pboView, cropA);

      /* readPixels 写入 PBO 偏移（dstOffset=16） */
      gl2.bufferData(gl2.PIXEL_PACK_BUFFER, cropLen + 16, gl2.STREAM_READ);
      gl2.readPixels(16, 8, 32, 24, gl2.RGBA, gl2.UNSIGNED_BYTE, 16);
      var offsetView = new Uint8Array(cropLen);
      gl2.getBufferSubData(gl2.PIXEL_PACK_BUFFER, 16, offsetView);
      readback.pboOffsetMatchesTyped = bytesEqual(offsetView, cropA);

      /* getBufferSubData 目标数组 dstOffset */
      var dst = new Uint8Array(cropLen + 16).fill(0xaa);
      gl2.bufferData(gl2.PIXEL_PACK_BUFFER, cropLen, gl2.STREAM_READ);
      gl2.readPixels(16, 8, 32, 24, gl2.RGBA, gl2.UNSIGNED_BYTE, 0);
      gl2.getBufferSubData(gl2.PIXEL_PACK_BUFFER, 0, dst, 8, cropLen);
      var prefixIntact = true;
      for (var i = 0; i < 8; i++) if (dst[i] !== 0xaa) prefixIntact = false;
      readback.getBufferSubDataDstOffset = {
        matches: bytesEqual(dst.subarray(8, 8 + cropLen), cropA), prefixIntact: prefixIntact
      };
      readback.basicError = drainErrors(gl2);
      gl2.bindBuffer(gl2.PIXEL_PACK_BUFFER, null);

      /* RGB 是否可读由原生实现决定；不支持时必须保持目标哨兵字节。 */
      var rgbW = 33, rgbH = 24, rgbX = 15, rgbY = 8;
      var rgbaRef = new Uint8Array(rgbW * rgbH * 4);
      gl2.readPixels(rgbX, rgbY, rgbW, rgbH, gl2.RGBA, gl2.UNSIGNED_BYTE, rgbaRef);
      var rgbAlign1Len = rgbW * 3 * rgbH;
      gl2.pixelStorei(gl2.PACK_ALIGNMENT, 1);
      var rgbAlign1 = new Uint8Array(rgbAlign1Len).fill(0xa5);
      gl2.readPixels(rgbX, rgbY, rgbW, rgbH, gl2.RGB, gl2.UNSIGNED_BYTE, rgbAlign1);
      var align1Err = drainErrors(gl2);
      gl2.pixelStorei(gl2.PACK_ALIGNMENT, 4);
      var stride4 = Math.ceil((rgbW * 3) / 4) * 4;
      var rgbAlign4 = new Uint8Array(stride4 * rgbH).fill(0xa5);
      gl2.readPixels(rgbX, rgbY, rgbW, rgbH, gl2.RGB, gl2.UNSIGNED_BYTE, rgbAlign4);
      var align4Err = drainErrors(gl2);
      var padBytes = [];
      for (var row = 0; row < rgbH; row++)
        for (var pad = rgbW * 3; pad < stride4; pad++) padBytes.push(rgbAlign4[row * stride4 + pad]);
      var packed4 = extractRows(rgbAlign4, stride4, 0, 0, rgbW, rgbH, 3);
      readback.rgbPacking = {
        supported: align1Err.count === 0 && align4Err.count === 0,
        align1Error: align1Err, align4Error: align4Err,
        rejectedWithoutMutation: align1Err.count === 1 && align1Err.last === gl2.INVALID_OPERATION &&
          align4Err.count === 1 && align4Err.last === gl2.INVALID_OPERATION &&
          rgbAlign1.every(function (v) { return v === 0xa5; }) &&
          rgbAlign4.every(function (v) { return v === 0xa5; }),
        stride1: rgbW * 3, stride4: stride4,
        align1EqualsAlign4: bytesEqual(rgbAlign1, packed4),
        rgbMatchesRgbaChannels: bytesEqual(packed4,
          (function () {
            var only = new Uint8Array(rgbW * rgbH * 3), o = 0;
            for (var p = 0; p < rgbW * rgbH; p++) {
              only[o++] = rgbaRef[p * 4]; only[o++] = rgbaRef[p * 4 + 1]; only[o++] = rgbaRef[p * 4 + 2];
            }
            return only;
          })()),
        padByteValues: Array.from(new Set(padBytes))
      };

      /* RGBA 保证可读；alignment=8 使 33 像素行产生四字节填充。 */
      gl2.pixelStorei(gl2.PACK_ALIGNMENT, 8);
      var rgbaStride = 136;
      var rgbaPacked = new Uint8Array(rgbaStride * rgbH + 16).fill(0xa5);
      gl2.readPixels(rgbX, rgbY, rgbW, rgbH, gl2.RGBA, gl2.UNSIGNED_BYTE, rgbaPacked, 8);
      var rgbaPackingError = drainErrors(gl2);
      var rgbaPaddingIntact = true;
      for (var byte = 0; byte < rgbaPacked.length; byte++) {
        var relative = byte - 8;
        if (relative < 0 || relative >= rgbaStride * rgbH || relative % rgbaStride >= rgbW * 4) {
          if (rgbaPacked[byte] !== 0xa5) rgbaPaddingIntact = false;
        }
      }
      readback.rgbaPacking = {
        alignment: 8, stride: rgbaStride, dstOffset: 8, error: rgbaPackingError,
        matches: bytesEqual(extractRows(rgbaPacked.subarray(8), rgbaStride, 0, 0, rgbW, rgbH, 4), rgbaRef),
        paddingIntact: rgbaPaddingIntact
      };
      gl2.pixelStorei(gl2.PACK_ALIGNMENT, 4);

      /* PACK_ROW_LENGTH / SKIP_PIXELS / SKIP_ROWS */
      gl2.pixelStorei(gl2.PACK_ROW_LENGTH, 64);
      var rowLenBuf = new Uint8Array(64 * 4 * 24);
      gl2.readPixels(16, 8, 32, 24, gl2.RGBA, gl2.UNSIGNED_BYTE, rowLenBuf);
      var rowLenErr = drainErrors(gl2);
      var rowLenExtract = extractRows(rowLenBuf, 64 * 4, 0, 0, 32, 24, 4);
      readback.rowLength = {
        error: rowLenErr, matchesCrop: bytesEqual(rowLenExtract, cropA)
      };
      gl2.pixelStorei(gl2.PACK_SKIP_PIXELS, 16);
      gl2.pixelStorei(gl2.PACK_SKIP_ROWS, 8);
      var skipBuf = new Uint8Array(64 * (8 + 24) * 4);
      gl2.readPixels(16, 8, 32, 24, gl2.RGBA, gl2.UNSIGNED_BYTE, skipBuf);
      var skipErr = drainErrors(gl2);
      readback.skipPixelsRows = { error: skipErr,
        matchesCrop: bytesEqual(extractRows(skipBuf, 64 * 4, 8, 16, 32, 24, 4), cropA) };
      gl2.pixelStorei(gl2.PACK_ROW_LENGTH, 0);
      gl2.pixelStorei(gl2.PACK_SKIP_PIXELS, 0);
      gl2.pixelStorei(gl2.PACK_SKIP_ROWS, 0);

      /* FLOAT 读回（RGBA32F framebuffer，EXT_color_buffer_float） */
      var floatExt = gl2.getExtension('EXT_color_buffer_float');
      readback.float = { extAvailable: !!floatExt };
      if (floatExt) {
        var tex = gl2.createTexture();
        gl2.bindTexture(gl2.TEXTURE_2D, tex);
        gl2.texStorage2D(gl2.TEXTURE_2D, 1, gl2.RGBA32F, 8, 8);
        var fbo = gl2.createFramebuffer();
        gl2.bindFramebuffer(gl2.FRAMEBUFFER, fbo);
        gl2.framebufferTexture2D(gl2.FRAMEBUFFER, gl2.COLOR_ATTACHMENT0, gl2.TEXTURE_2D, tex, 0);
        var status = gl2.checkFramebufferStatus(gl2.FRAMEBUFFER);
        readback.float.framebufferComplete = status === gl2.FRAMEBUFFER_COMPLETE;
        if (readback.float.framebufferComplete) {
          var expectedFloats = [0.25, -0.5, 0.125, 1.0];
          gl2.clearBufferfv(gl2.COLOR, 0, new Float32Array(expectedFloats));
          var fTyped = new Float32Array(8 * 8 * 4);
          gl2.readPixels(0, 0, 8, 8, gl2.RGBA, gl2.FLOAT, fTyped);
          var fTypedErr = drainErrors(gl2);
          gl2.bindBuffer(gl2.PIXEL_PACK_BUFFER, pbo);
          gl2.bufferData(gl2.PIXEL_PACK_BUFFER, 8 * 8 * 4 * 4, gl2.STREAM_READ);
          gl2.readPixels(0, 0, 8, 8, gl2.RGBA, gl2.FLOAT, 0);
          var fPbo = new Float32Array(8 * 8 * 4);
          gl2.getBufferSubData(gl2.PIXEL_PACK_BUFFER, 0, fPbo);
          var fPboErr = drainErrors(gl2);
          var maxUlp = 0, first8Bits = [];
          readback.float.pboTypedMismatch = 0;
          readback.float.samplesCompared = fTyped.length;
          for (var p = 0; p < fTyped.length; p++) {
            if (p < 4) first8Bits.push('0x' + f32Bits(fTyped[p]).toString(16).padStart(8, '0'));
            var same = f32Bits(fTyped[p]) === f32Bits(fPbo[p]);
            if (!same) readback.float.pboTypedMismatch = (readback.float.pboTypedMismatch || 0) + 1;
          }
          for (var q = 0; q < fTyped.length; q += 4) {
            for (var ch2 = 0; ch2 < 4; ch2++) {
              var got = fTyped[q + ch2], exp = expectedFloats[ch2];
              var ulp = Infinity;
              if (got === exp) ulp = 0;
              else if (Math.sign(got) === Math.sign(exp)) ulp = Math.abs(f32Bits(got) - f32Bits(exp));
              if (ulp > maxUlp) maxUlp = ulp;
            }
          }
          readback.float.typedError = fTypedErr;
          readback.float.pboError = fPboErr;
          readback.float.firstSampleBits = first8Bits;
          readback.float.maxUlpFromClear = maxUlp;
        }
        gl2.bindFramebuffer(gl2.FRAMEBUFFER, null);
        gl2.deleteFramebuffer(fbo);
        gl2.deleteTexture(tex);
      }

      /* 普通 buffer 不被改写；覆盖/复制/部分覆盖语义 */
      var buffers = out.buffers = {};
      var pattern = new Uint8Array(256);
      for (var k = 0; k < 256; k++) pattern[k] = (k * 7 + 3) & 0xff;
      var plainBuf = gl2.createBuffer();
      gl2.bindBuffer(gl2.PIXEL_PACK_BUFFER, plainBuf);
      gl2.bufferData(gl2.PIXEL_PACK_BUFFER, pattern, gl2.STATIC_DRAW);
      var plainView = new Uint8Array(256);
      gl2.getBufferSubData(gl2.PIXEL_PACK_BUFFER, 0, plainView);
      buffers.plainUnchanged = bytesEqual(plainView, pattern);

      /* readPixels 后同一 buffer 含读回数据 */
      gl2.bindFramebuffer(gl2.FRAMEBUFFER, null);
      paintQuadrants(gl2);
      gl2.bindBuffer(gl2.PIXEL_PACK_BUFFER, null);
      var smallTyped = new Uint8Array(8 * 8 * 4);
      gl2.readPixels(8, 8, 8, 8, gl2.RGBA, gl2.UNSIGNED_BYTE, smallTyped);
      gl2.bindBuffer(gl2.PIXEL_PACK_BUFFER, plainBuf);
      gl2.bufferData(gl2.PIXEL_PACK_BUFFER, 256, gl2.STREAM_READ);
      gl2.readPixels(8, 8, 8, 8, gl2.RGBA, gl2.UNSIGNED_BYTE, 0);
      var afterRead = new Uint8Array(256);
      gl2.getBufferSubData(gl2.PIXEL_PACK_BUFFER, 0, afterRead);
      buffers.readbackSeen = bytesEqual(afterRead, smallTyped);

      /* bufferData 覆盖后恢复为纯上传字节（来源标记应被清除） */
      var pattern2 = new Uint8Array(256).fill(0x5a);
      gl2.bufferData(gl2.PIXEL_PACK_BUFFER, pattern2, gl2.STATIC_DRAW);
      var afterOverwrite = new Uint8Array(256);
      gl2.getBufferSubData(gl2.PIXEL_PACK_BUFFER, 0, afterOverwrite);
      buffers.overwriteClearsReadback = bytesEqual(afterOverwrite, pattern2);

      /* copyBufferSubData 保留数据 */
      gl2.bufferData(gl2.PIXEL_PACK_BUFFER, 256, gl2.STREAM_READ);
      gl2.readPixels(8, 8, 8, 8, gl2.RGBA, gl2.UNSIGNED_BYTE, 0);
      var copyDst = gl2.createBuffer();
      gl2.bindBuffer(gl2.COPY_WRITE_BUFFER, copyDst);
      gl2.bufferData(gl2.COPY_WRITE_BUFFER, 256, gl2.STREAM_READ);
      gl2.bindBuffer(gl2.COPY_READ_BUFFER, plainBuf);
      gl2.copyBufferSubData(gl2.COPY_READ_BUFFER, gl2.COPY_WRITE_BUFFER, 0, 0, 256);
      var copyView = new Uint8Array(256);
      gl2.bindBuffer(gl2.PIXEL_PACK_BUFFER, copyDst);
      gl2.getBufferSubData(gl2.PIXEL_PACK_BUFFER, 0, copyView);
      buffers.copyPreserved = bytesEqual(copyView, smallTyped);
      var copyErr = drainErrors(gl2);

      /* 部分覆盖：前 128 字节保留读回，后 128 字节为上传数据 */
      var half = new Uint8Array(128).fill(0x33);
      gl2.bindBuffer(gl2.PIXEL_PACK_BUFFER, copyDst);
      gl2.bufferData(gl2.PIXEL_PACK_BUFFER, 256, gl2.STREAM_READ);
      gl2.readPixels(8, 8, 8, 8, gl2.RGBA, gl2.UNSIGNED_BYTE, 0);
      gl2.bufferSubData(gl2.PIXEL_PACK_BUFFER, 128, half);
      var partialView = new Uint8Array(256);
      gl2.getBufferSubData(gl2.PIXEL_PACK_BUFFER, 0, partialView);
      buffers.partialOverwrite = {
        headPreserved: bytesEqual(partialView.subarray(0, 128), smallTyped.subarray(0, 128)),
        tailMatches: bytesEqual(partialView.subarray(128), half)
      };
      /* 非像素对齐写入/复制和失败写入，不能污染相邻通道的来源信息。 */
      gl2.bufferData(gl2.PIXEL_PACK_BUFFER, 256, gl2.STREAM_READ);
      gl2.readPixels(8, 8, 8, 8, gl2.RGBA, gl2.UNSIGNED_BYTE, 0);
      gl2.bufferSubData(gl2.PIXEL_PACK_BUFFER, 1, new Uint8Array([0x31, 0x72]));
      var byteExpected = smallTyped.slice();
      byteExpected.set([0x31, 0x72], 1);
      var byteActual = new Uint8Array(256);
      gl2.getBufferSubData(gl2.PIXEL_PACK_BUFFER, 0, byteActual);
      buffers.byteOverwrite = { matches: bytesEqual(byteActual, byteExpected), error: drainErrors(gl2) };
      gl2.bindBuffer(gl2.COPY_READ_BUFFER, copyDst);
      gl2.bindBuffer(gl2.COPY_WRITE_BUFFER, plainBuf);
      gl2.bufferData(gl2.COPY_WRITE_BUFFER, new Uint8Array(260).fill(0xa5), gl2.STREAM_READ);
      gl2.copyBufferSubData(gl2.COPY_READ_BUFFER, gl2.COPY_WRITE_BUFFER, 1, 3, 253);
      var byteCopy = new Uint8Array(260);
      gl2.getBufferSubData(gl2.COPY_WRITE_BUFFER, 0, byteCopy);
      var byteCopyExpected = new Uint8Array(260).fill(0xa5);
      byteCopyExpected.set(byteExpected.subarray(1, 254), 3);
      buffers.byteCopy = { matches: bytesEqual(byteCopy, byteCopyExpected), error: drainErrors(gl2) };
      gl2.readPixels(0, 0, 8, 8, gl2.RGBA, gl2.UNSIGNED_BYTE, 1);
      var rejectedRead = drainErrors(gl2);
      gl2.bufferSubData(gl2.PIXEL_PACK_BUFFER, 255, new Uint8Array([1, 2]));
      var rejectedWrite = drainErrors(gl2);
      gl2.copyBufferSubData(gl2.COPY_READ_BUFFER, gl2.COPY_WRITE_BUFFER, 255, 0, 8);
      var rejectedCopy = drainErrors(gl2);
      var afterFailure = new Uint8Array(256), copyAfterFailure = new Uint8Array(260);
      gl2.getBufferSubData(gl2.PIXEL_PACK_BUFFER, 0, afterFailure);
      gl2.getBufferSubData(gl2.COPY_WRITE_BUFFER, 0, copyAfterFailure);
      buffers.failedMutations = {
        readError: rejectedRead, writeError: rejectedWrite, copyError: rejectedCopy,
        sourceUnchanged: bytesEqual(afterFailure, byteExpected),
        destinationUnchanged: bytesEqual(copyAfterFailure, byteCopyExpected), finalError: drainErrors(gl2)
      };
      buffers.copyError = copyErr;
      gl2.bindBuffer(gl2.PIXEL_PACK_BUFFER, null);
      gl2.bindBuffer(gl2.COPY_READ_BUFFER, null);
      gl2.bindBuffer(gl2.COPY_WRITE_BUFFER, null);

      /* 错误语义 */
      var errors = out.errors = {};
      var bad = new Float32Array(3);
      var threw = null;
      try { gl2.readPixels(0, 0, 1, 1, gl2.RGB, gl2.FLOAT, bad); } catch (e) { threw = String(e && e.message || e); }
      errors.incompatibleFormatType = { threw: threw, error: drainErrors(gl2), expected: 'INVALID_OPERATION(0x502)' };
      threw = null;
      try { gl2.pixelStorei(gl2.PACK_ALIGNMENT, 3); } catch (e) { threw = String(e && e.message || e); }
      gl2.pixelStorei(gl2.PACK_ALIGNMENT, 4);
      errors.invalidAlignment = { threw: threw, error: drainErrors(gl2), expected: 'INVALID_VALUE(0x501)' };
      threw = null;
      try {
        var tiny = gl2.createBuffer();
        gl2.bindBuffer(gl2.PIXEL_PACK_BUFFER, tiny);
        gl2.bufferData(gl2.PIXEL_PACK_BUFFER, 8, gl2.STREAM_READ);
        gl2.getBufferSubData(gl2.PIXEL_PACK_BUFFER, 0, new Uint8Array(16));
      } catch (e) { threw = String(e && e.message || e); }
      gl2.bindBuffer(gl2.PIXEL_PACK_BUFFER, null);
      errors.getBufferSubDataOutOfRange = { threw: threw, error: drainErrors(gl2), expected: 'INVALID_VALUE(0x501)' };

      var shader = gl2.createShader(gl2.FRAGMENT_SHADER);
      gl2.shaderSource(shader, 'this is definitely not glsl');
      gl2.compileShader(shader);
      var compileStatus = gl2.getShaderParameter(shader, gl2.COMPILE_STATUS);
      var infoLog = gl2.getShaderInfoLog(shader);
      errors.shaderCompile = { statusFalse: compileStatus === false, infoLog: infoLog, infoLogNonEmpty: !!infoLog && infoLog.length > 0 };
      gl2.deleteShader(shader);
      var prog = gl2.createProgram();
      gl2.linkProgram(prog);
      var linkStatus = gl2.getProgramParameter(prog, gl2.LINK_STATUS);
      var linkLog = gl2.getProgramInfoLog(prog);
      errors.programLink = { statusFalse: linkStatus === false, infoLog: linkLog };
      gl2.deleteProgram(prog);
      errors.residualErrors = drainErrors(gl2);

      /* 序列化边界：WebGL canvas → PNG 序列化与直接 readPixels 同用 WebGL domain。
         用 ImageDecoder+VideoFrame.copyTo 取原始序列化字节；不把 PNG 画回 2D canvas
         再 getImageData（那会叠加 Canvas domain 的处理，不能当作直接解码字节）。 */
      paintQuadrants(gl2);
      var bottomUp = new Uint8Array(CANVAS_W * CANVAS_H * 4);
      gl2.readPixels(0, 0, CANVAS_W, CANVAS_H, gl2.RGBA, gl2.UNSIGNED_BYTE, bottomUp);
      var snap = new Uint8Array(CANVAS_W * CANVAS_H * 4);
      // readPixels 自下向上，PNG 自上向下；只正规化行顺序，不改变任何像素。
      for (var row = 0; row < CANVAS_H; row++) {
        var start = (CANVAS_H - row - 1) * CANVAS_W * 4;
        snap.set(bottomUp.subarray(start, start + CANVAS_W * 4), row * CANVAS_W * 4);
      }
      var serialization = readback.serialization = {
        snapshotWidth: CANVAS_W, snapshotHeight: CANVAS_H
      };
      var glBlob = new Promise(function (resolve, reject) {
        canvas2.toBlob(function (b) { b ? resolve(b) : reject(new Error('toBlob 返回 null')); }, 'image/png');
      });
      var serializationPromise = sha256Hex(snap.buffer).then(function (d) {
        serialization.snapshotDigest = d;
        return glBlob;
      }).then(function (blob) {
        return blob.arrayBuffer().then(function (buf) {
          var bytes = new Uint8Array(buf);
          serialization.png = { type: blob.type, length: bytes.length,
                                magic: hexOf(buf.slice(0, 8)),
                                bitDepth: bytes.length > 25 ? bytes[24] : null };
          return sha256Hex(buf).then(function (d) {
            serialization.png.digest = d;
            return decodePngRaw(buf.slice(0));
          });
        });
      }).then(function (raw) {
        if (raw.bytes) {
          serialization.rawDecode = { supported: raw.supported, format: raw.format,
                                      rgbaDigest: raw.rgbaDigest,
                                      byteLength: raw.byteLength, digest: null,
                                      firstBytes: Array.from(raw.bytes.slice(0, 8)) };
        } else {
          serialization.rawDecode = { supported: raw.supported,
                                      error: raw.error || raw.reason || '无原始字节' };
        }
        serialization.serializedMatchesSnapshot = rawVsTarget(raw, snap, CANVAS_W * CANVAS_H);
        return raw.bytes ? sha256Hex(raw.bytes.buffer) : null;
      }).then(function (d) {
        if (serialization.rawDecode && d) serialization.rawDecode.digest = d;
      }, function (err) {
        serialization.error = String(err && err.message || err);
      });

      resources.glContexts.push({ label: 'webgl', gl: gl1 });
      resources.glContexts.push({ label: 'webgl2', gl: gl2 });
      return serializationPromise.then(function () {
        return sha256Hex(full.buffer).then(function (d) {
          readback.fullDigest = d;
          return sha256Hex(cropA.buffer);
        }).then(function (d) {
          readback.cropDigest = d;
          return out;
        });
      });
    }
    if (gl1) resources.glContexts.push({ label: 'webgl', gl: gl1 });
    return out;
  });
}

/* ------------------------------ WebGPU 组 ------------------------------ */

async function webgpuGroup() {
    if (!('gpu' in navigator)) return { supported: false, unavailable: 'api-unavailable', reason: 'navigator.gpu 不存在' };
    var adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return { supported: false, unavailable: 'adapter-unavailable', adapterRequested: true, reason: 'requestAdapter() 返回 null' };
      var info = adapter.info;
      var limitKeys = ['maxTextureDimension1D', 'maxTextureDimension2D', 'maxTextureDimension3D',
                       'maxBufferSize', 'maxComputeWorkgroupStorageSize', 'maxComputeInvocationsPerWorkgroup',
                       'maxComputeWorkgroupSizeX', 'maxStorageBufferBindingSize', 'maxBindGroups',
                       'maxTimestampWrites'];
      var limits = {};
      limitKeys.forEach(function (k) { limits[k] = typeof adapter.limits[k] === 'number' ? adapter.limits[k] : null; });
      var out = {
        supported: true,
        adapterInfo: {
          vendor: typeof info.vendor === 'string' ? info.vendor : null,
          architecture: typeof info.architecture === 'string' ? info.architecture : null,
          device: typeof info.device === 'string' ? info.device : null,
          description: typeof info.description === 'string' ? info.description : null,
          subgroupMinSize: typeof info.subgroupMinSize === 'number' ? info.subgroupMinSize : null,
          subgroupMaxSize: typeof info.subgroupMaxSize === 'number' ? info.subgroupMaxSize : null,
          isFallbackAdapter: info.isFallbackAdapter === true
        },
        limits: limits,
        features: Array.from(adapter.features),
        featureCount: adapter.features.size,
        preferredCanvasFormat: navigator.gpu.getPreferredCanvasFormat ? navigator.gpu.getPreferredCanvasFormat() : null,
        wgslFeatures: navigator.gpu.wgslFeatures ? Array.from(navigator.gpu.wgslFeatures) : null
      };
    var device, texture, buffer, scoped = false;
    try {
      device = await adapter.requestDevice();
      device.pushErrorScope('validation');
      scoped = true;
      var shader = device.createShaderModule({ code:
        '@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {' +
        'let p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));' +
        'return vec4f(p[i], 0, 1); }' +
        '@fragment fn fs() -> @location(0) vec4f { return vec4f(0.2, 0.4, 0.6, 1); }'
      });
      out.shaderMessages = Array.from((await shader.getCompilationInfo()).messages, function (m) {
        return { type: m.type, message: m.message, lineNum: m.lineNum, linePos: m.linePos };
      });
      var pipeline = await device.createRenderPipelineAsync({
        layout: 'auto',
        vertex: { module: shader, entryPoint: 'vs' },
        fragment: { module: shader, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
        primitive: { topology: 'triangle-list' }
      });
      texture = device.createTexture({
        size: [8, 8], format: 'rgba8unorm',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC
      });
      buffer = device.createBuffer({ size: 8 * 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      var encoder = device.createCommandEncoder();
      var pass = encoder.beginRenderPass({ colorAttachments: [{
        view: texture.createView(), clearValue: [0, 0, 0, 0], loadOp: 'clear', storeOp: 'store'
      }] });
      pass.setPipeline(pipeline);
      pass.draw(3);
      pass.end();
      encoder.copyTextureToBuffer({ texture: texture }, { buffer: buffer, bytesPerRow: 256 }, [8, 8]);
      device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      var mapped = buffer.getMappedRange();
      var rgba = new Uint8Array(8 * 8 * 4);
      for (var row = 0; row < 8; row++) rgba.set(new Uint8Array(mapped, row * 256, 8 * 4), row * 8 * 4);
      buffer.unmap();
      out.render = { width: 8, height: 8, format: 'rgba8unorm', rgba: Array.from(rgba),
                     digest: await sha256Hex(rgba.buffer) };
    } catch (err) {
      out.error = String(err && err.message || err);
    } finally {
      if (scoped) {
        try {
          var validation = await device.popErrorScope();
          if (validation) out.validationError = validation.message;
        } catch (err) { out.validationError = String(err && err.message || err); }
      }
      if (buffer) buffer.destroy();
      if (texture) texture.destroy();
      if (device) device.destroy();
    }
    return out;
}

/* ------------------------------ Canvas 2D 组 ------------------------------ */

function canvas2dGroup() {
  return Promise.resolve().then(function () {
    var out = {};
    var canvas = document.createElement('canvas');
    canvas.width = CANVAS_W; canvas.height = CANVAS_H;
    var ctx = canvas.getContext('2d', { alpha: true, willReadFrequently: true });
    drawOps(ctx);
    var full = ctx.getImageData(0, 0, CANVAS_W, CANVAS_H);
    var cropA = ctx.getImageData(16, 8, 32, 24);
    var cropB = ctx.getImageData(16, 8, 32, 24);
    var fromFull = extractRows(full.data, CANVAS_W * 4, 8, 16, 32, 24, 4);
    var semi = 0;
    for (var i = 3; i < full.data.length; i += 4) if (full.data[i] > 0 && full.data[i] < 255) semi++;
    out.geometry = {
      cropMatchesFull: bytesEqual(cropA.data, fromFull),
      cropFirstDiff: firstDiff(cropA.data, fromFull),
      repeatIdentical: bytesEqual(cropA.data, cropB.data),
      semiTransparentPixels: semi,
      firstPixelBytes: Array.from(full.data.slice(0, 8))
    };

    /* toDataURL → PNG 字节（data: URL fetch）→ ImageDecoder 原始字节 vs getImageData */
    var dataUrl = canvas.toDataURL('image/png');
    out.toDataURL = { prefix: dataUrl.slice(0, 22), length: dataUrl.length };
    var decodeCompare = withTimeout(fetch(dataUrl).then(function (r) {
      return r.arrayBuffer();
    }), 6000, 'dataurl-fetch').then(function (buf) {
      return decodePngRaw(buf).then(function (raw) {
        if (raw.bytes) {
          out.toDataURL.rawDecode = { supported: raw.supported, format: raw.format,
                                      rgbaDigest: raw.rgbaDigest,
                                      byteLength: raw.byteLength, digest: null,
                                      firstBytes: Array.from(raw.bytes.slice(0, 8)) };
        } else {
          out.toDataURL.rawDecode = { supported: raw.supported,
                                      error: raw.error || raw.reason || '无原始字节' };
        }
        out.toDataURL.rawDecodeVsGetImageData = rawVsTarget(raw, full.data, CANVAS_W * CANVAS_H);
        return raw.bytes ? sha256Hex(raw.bytes.buffer) : null;
      }).then(function (d) {
        if (out.toDataURL.rawDecode && d) out.toDataURL.rawDecode.digest = d;
        return out.toDataURL.rawDecodeVsGetImageData;
      });
    });

    /* toBlob → PNG 字节 + 解码对照 */
    var blobPromise = new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) {
        if (!blob) { reject(new Error('toBlob 返回 null')); return; }
        resolve(blob);
      }, 'image/png');
    });

    return Promise.all([
      decodeCompare,
      blobPromise.then(function (blob) {
        return blob.arrayBuffer().then(function (buf) {
          var bytes = new Uint8Array(buf);
          return sha256Hex(buf).then(function (digest) {
            out.toBlob = {
              type: blob.type, length: bytes.length,
              magic: hexOf(buf.slice(0, 8)), digest: digest
            };
            /* 同一非预乘表示逐字节比较，包含半透明像素。 */
            return decodePngRaw(buf.slice(0)).then(function (raw) {
              if (raw.bytes) {
                out.toBlob.rawDecode = { supported: raw.supported, format: raw.format,
                                         rgbaDigest: raw.rgbaDigest,
                                         byteLength: raw.byteLength, digest: null,
                                         firstBytes: Array.from(raw.bytes.slice(0, 8)) };
              } else {
                out.toBlob.rawDecode = { supported: raw.supported,
                                         error: raw.error || raw.reason || '无原始字节' };
              }
              out.toBlob.rawDecodeVsGetImageData = rawVsTarget(raw, full.data, CANVAS_W * CANVAS_H);
              return raw.bytes ? sha256Hex(raw.bytes.buffer) : null;
            }).then(function (d) {
              if (out.toBlob.rawDecode && d) out.toBlob.rawDecode.digest = d;
            });
          });
        });
      }),
      /* OffscreenCanvas：convertToBlob + 自解码（与 worker 端同一绘制序列对照） */
      Promise.resolve().then(function () {
        var oc = new OffscreenCanvas(CANVAS_W, CANVAS_H);
        var octx = oc.getContext('2d', { alpha: true });
        drawOps(octx);
        var pixels = octx.getImageData(0, 0, CANVAS_W, CANVAS_H);
        return sha256Hex(pixels.data.buffer).then(function (pixelDigest) {
          return oc.convertToBlob({ type: 'image/png' }).then(function (blob) {
            return blob.arrayBuffer().then(function (buf) {
              return sha256Hex(buf).then(function (pngDigest) {
                out.offscreen = {
                  pixelDigest: pixelDigest,
                  png: { type: blob.type, length: new Uint8Array(buf).length,
                         magic: hexOf(buf.slice(0, 8)), digest: pngDigest }
                };
                return decodePngRaw(buf).then(function (raw) {
                  if (!raw.bytes) throw new Error(raw.error || raw.reason || 'PNG 原始解码失败');
                  var decoded = rgbaOfRaw(raw.bytes, raw.format, CANVAS_W * CANVAS_H);
                  out.offscreen.rawDecode = { supported: raw.supported, format: raw.format,
                                              rgbaDigest: raw.rgbaDigest };
                  out.offscreen.rawCompare = rawVsTarget(raw, pixels.data, CANVAS_W * CANVAS_H);
                  return sha256Hex(decoded.buffer).then(function (decodedDigest) {
                    out.offscreen.decodedPixelDigest = decodedDigest;
                    out.offscreen.decodedMatchesDirect = decodedDigest === pixelDigest;
                    return null;
                  });
                });
              });
            });
          });
        });
      }),
      /* 错误与 taint 语义 */
      Promise.resolve().then(function () {
        var errors = out.errors = {};
        try { ctx.getImageData(0, 0, 0, 0); errors.emptySizeGetImageData = { threw: false }; }
        catch (e) { errors.emptySizeGetImageData = { threw: true, name: e.name, message: e.message }; }
        var zero = document.createElement('canvas');
        zero.width = zero.height = 0;
        errors.zeroSizeToDataURL = { value: zero.toDataURL(), expected: 'data:,' };
        try {
          var oob = ctx.getImageData(60, 40, 32, 24);
          var insideOk = true, outsideOk = true;
          for (var y = 0; y < 24; y++) {
            for (var x = 0; x < 32; x++) {
              var px = 60 + x, py = 40 + y, di = (y * 32 + x) * 4;
              if (px >= CANVAS_W || py >= CANVAS_H) {
                for (var ch3 = 0; ch3 < 4; ch3++) if (oob.data[di + ch3] !== 0) outsideOk = false;
              } else {
                var si = (py * CANVAS_W + px) * 4;
                for (var ch4 = 0; ch4 < 4; ch4++)
                  if (oob.data[di + ch4] !== full.data[si + ch4]) insideOk = false;
              }
            }
          }
          errors.outOfBoundsCrop = { threw: false, insideMatches: insideOk, outsideTransparent: outsideOk };
        } catch (e) { errors.outOfBoundsCrop = { threw: true, name: e.name, message: e.message }; }

        /* taint：blob URL 的 SVG 含 foreignObject（非 data: URL，触发多安全来源判定） */
        return new Promise(function (resolve) {
          var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">' +
            '<foreignObject width="16" height="16">' +
            '<div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject></svg>';
          var url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
          resources.blobUrls.push(url);
          var img = new Image();
          img.onload = function () {
            var tc = document.createElement('canvas');
            tc.width = 16; tc.height = 16;
            var tctx = tc.getContext('2d');
            tctx.drawImage(img, 0, 0);
            var result = {};
            try { tctx.getImageData(0, 0, 1, 1); result.getImageData = { threw: false }; }
            catch (e) { result.getImageData = { threw: true, name: e.name, message: e.message }; }
            try { result.toDataURL = { threw: false, prefix: tc.toDataURL().slice(0, 10) }; }
            catch (e) { result.toDataURL = { threw: true, name: e.name, message: e.message }; }
            errors.taint = result;
            resolve(null);
          };
          img.onerror = function () {
            errors.taint = { error: 'foreignObject SVG 图片解码失败', securityErrorObserved: false };
            resolve(null);
          };
          img.src = url;
        });
      })
    ]).then(function (results) {
      out.toDataURL.rawCompare = results[0];
      return sha256Hex(full.data.buffer);
    }).then(function (d) {
      out.geometry.fullDigest = d;
      return sha256Hex(cropA.data.buffer);
    }).then(function (d) {
      out.geometry.cropDigest = d;
      return out;
    });
  });
}

/* ------------------------------ float16 组 ------------------------------ */

function float16Group() {
  return Promise.resolve().then(function () {
    var out = { supported: typeof OffscreenCanvas === 'function' };
    if (!out.supported) return out;
    var bits = EXPECTATIONS.float16InputBits;
    var u16 = new Uint16Array(bits);
    var f16 = new Float16Array(u16.buffer);

    var oc = new OffscreenCanvas(1, 1);
    var ctx = oc.getContext('2d', { colorType: 'float16', colorSpace: 'srgb', alpha: true });
    if (!ctx || !ctx.getContextAttributes || ctx.getContextAttributes().colorType !== 'float16') {
      out.error = 'getContext("2d", {colorType:"float16"}) 不可用';
      out.attributes = ctx && ctx.getContextAttributes ? ctx.getContextAttributes() : null;
      return out;
    }
    out.attributes = ctx.getContextAttributes();
    ctx.putImageData(new ImageData(new Float16Array(f16), 1, 1, { pixelFormat: 'rgba-float16' }), 0, 0);
    var read1 = ctx.getImageData(0, 0, 1, 1, { pixelFormat: 'rgba-float16' });
    var read2 = ctx.getImageData(0, 0, 1, 1, { pixelFormat: 'rgba-float16' });
    var b1 = new Uint16Array(read1.data.buffer);
    var b2 = new Uint16Array(read2.data.buffer);
    out.baselinePixel = {
      inputBits: bits.map(function (v) { return '0x' + v.toString(16).padStart(4, '0'); }),
      directBits: Array.from(b1).map(function (v) { return '0x' + v.toString(16).padStart(4, '0'); }),
      directValues: Array.from(read1.data),
      repeatIdentical: bytesEqual(b1, b2),
      lsbDeltaCount: (function () { var n = 0; for (var i = 0; i < 4; i++) if (b1[i] !== u16[i]) n++; return n; })()
    };
    var rgba8 = ctx.getImageData(0, 0, 1, 1);
    out.baselinePixel.rgba8Snapshot = Array.from(rgba8.data);

    /* 2x1：区域读出 == 完整读出对应区域（含次正规数与较大正常值） */
    var bits2 = [0x0401, 0x1001, 0x3001, 0x3c00, 0x0001, 0x03ff, 0x7bff, 0x3555];
    var u162 = new Uint16Array(bits2);
    var oc2 = new OffscreenCanvas(2, 1);
    var ctx2 = oc2.getContext('2d', { colorType: 'float16', colorSpace: 'srgb', alpha: true });
    ctx2.putImageData(new ImageData(new Float16Array(u162.buffer), 2, 1, { pixelFormat: 'rgba-float16' }), 0, 0);
    var full2 = ctx2.getImageData(0, 0, 2, 1, { pixelFormat: 'rgba-float16' });
    var region = ctx2.getImageData(1, 0, 1, 1, { pixelFormat: 'rgba-float16' });
    var f2 = new Uint16Array(full2.data.buffer);
    var r2 = new Uint16Array(region.data.buffer);
    out.regionPixel = {
      inputBits: bits2.map(function (v) { return '0x' + v.toString(16).padStart(4, '0'); }),
      fullBits: Array.from(f2).map(function (v) { return '0x' + v.toString(16).padStart(4, '0'); }),
      regionEqualsFullSlice: bytesEqual(r2, f2.subarray(4, 8)),
      regionBits: Array.from(r2).map(function (v) { return '0x' + v.toString(16).padStart(4, '0'); })
    };

    /* NaN/Inf/零只记录原生行为，不做断言（补丁约定不改动这些值） */
    try {
      var bits3 = [0x7e00, 0x7c00, 0xfc00, 0x0000];
      var oc3 = new OffscreenCanvas(1, 1);
      var ctx3 = oc3.getContext('2d', { colorType: 'float16' });
      ctx3.putImageData(new ImageData(new Float16Array(new Uint16Array(bits3).buffer), 1, 1,
        { pixelFormat: 'rgba-float16' }), 0, 0);
      var b3 = new Uint16Array(ctx3.getImageData(0, 0, 1, 1, { pixelFormat: 'rgba-float16' }).data.buffer);
      out.specialValues = {
        inputBits: bits3.map(function (v) { return '0x' + v.toString(16).padStart(4, '0'); }),
        directBits: Array.from(b3).map(function (v) { return '0x' + v.toString(16).padStart(4, '0'); })
      };
    } catch (e) { out.specialValues = { error: String(e && e.message || e) }; }

    /* PNG 导出：解析 IHDR 位深度；解码用 ImageDecoder+VideoFrame.copyTo 记录原生
       量化结果（未再穿过 canvas getImageData / 二次扰动）。不与 float16 位模式强行
       等价，按原生转换报告。 */
    return oc.convertToBlob({ type: 'image/png' }).then(function (blob) {
      return blob.arrayBuffer().then(function (buf) {
        var bytes = new Uint8Array(buf);
        out.png = {
          type: blob.type, length: bytes.length,
          magic: hexOf(buf.slice(0, 8)),
          bitDepth: bytes.length > 25 ? bytes[24] : null,
          colorType: bytes.length > 25 ? bytes[25] : null,
          bytesBase64: btoa(String.fromCharCode.apply(null, bytes))
        };
        return sha256Hex(buf).then(function (digest) {
          out.png.digest = digest;
          return decodePngRaw(buf.slice(0));
        }).then(function (raw) {
          if (raw.bytes) {
            out.png.rawDecode = { supported: raw.supported, format: raw.format,
                                  rgbaDigest: raw.rgbaDigest,
                                  byteLength: raw.byteLength, digest: null,
                                  rgba8: Array.from(rgbaOfRaw(raw.bytes, raw.format, 1).subarray(0, 4)) };
          } else {
            out.png.rawDecode = { supported: raw.supported,
                                  error: raw.error || raw.reason || '无原始字节' };
          }
          return raw.bytes ? sha256Hex(raw.bytes.buffer) : null;
        }).then(function (d) {
          if (out.png.rawDecode && d) out.png.rawDecode.digest = d;
          return out;
        });
      });
    });
  });
}

/* ------------------------------ 音频组 ------------------------------ */

function buildSineContext() {
  var offline = new OfflineAudioContext(
    EXPECTATIONS.offlineAudio.channels, EXPECTATIONS.offlineAudio.length,
    EXPECTATIONS.offlineAudio.requestedSampleRate);
  var osc = offline.createOscillator();
  osc.type = 'sine';
  osc.frequency.value = 100;
  var gain = offline.createGain();
  gain.gain.value = 0.5;
  osc.connect(gain);
  gain.connect(offline.destination);
  osc.start(0);
  osc.stop(1);
  return offline;
}

function audioGroup() {
  return Promise.resolve().then(function () {
    var out = {};
    out.invalidSampleRate = {};
    ['live', 'offline'].forEach(function (kind) {
      try {
        var context = kind === 'live' ? new AudioContext({ sampleRate: 0 }) :
          new OfflineAudioContext(1, 128, 0);
        if (kind === 'live') resources.audioContexts.push(context);
        out.invalidSampleRate[kind] = { accepted: true, sampleRate: context.sampleRate };
      } catch (error) {
        out.invalidSampleRate[kind] = { accepted: false, error: error.name };
      }
    });
    var offline = buildSineContext();
    out.constructor = {
      length: offline.length, sampleRate: offline.sampleRate,
      channelCount: offline.destination.channelCount
    };
    return withTimeout(offline.startRendering(), 8000, 'offline-render').then(function (rendered) {
      var ch = rendered.getChannelData(0);
      var digestA = sha256Hex(ch.buffer);
      var digestB = sha256Hex(rendered.getChannelData(0).buffer);
      var first = new Float32Array(8);
      rendered.copyFromChannel(first, 0, 0);
      var copyMatches = true;
      for (var i = 0; i < 8; i++)
        if (!(first[i] === ch[i] || (Number.isNaN(first[i]) && Number.isNaN(ch[i])))) copyMatches = false;
      var offline2 = buildSineContext();
      return withTimeout(offline2.startRendering(), 8000, 'offline-render-2').then(function (r2) {
        return digestA.then(function (d1) {
          return digestB.then(function (d2) {
            return sha256Hex(r2.getChannelData(0).buffer).then(function (d3) {
              out.render = {
                length: rendered.length, sampleRate: rendered.sampleRate, duration: rendered.duration,
                sampleBits: Array.from(ch.slice(0, 8)).map(function (v) {
                  return '0x' + f32Bits(v).toString(16).padStart(8, '0');
                }),
                channelDataDigest: d1,
                repeatGetChannelDataDigest: d2,
                secondContextDigest: d3,
                copyFromChannelMatches: copyMatches,
                copyBits: Array.from(first).map(function (v) {
                  return '0x' + f32Bits(v).toString(16).padStart(8, '0');
                })
              };
              /* live AudioContext 与 buffer 写入语义 */
              var live = new AudioContext();
              resources.audioContexts.push(live);
              out.live = { defaultSampleRate: live.sampleRate, state: live.state };
              var explicit = new AudioContext({ sampleRate: 44100 });
              resources.audioContexts.push(explicit);
              out.live.explicitSampleRate = { requested: 44100, actual: explicit.sampleRate };
              var buf = live.createBuffer(2, 6, 48000);
              var cd = buf.getChannelData(0);
              var written = new Float32Array([0.5, -0.5, NaN, Infinity, -Infinity, 0]);
              for (var w = 0; w < 6; w++) cd[w] = written[w];
              var reader = new Float32Array(6);
              buf.copyFromChannel(reader, 0, 0);
              var same = true;
              for (var q = 0; q < 6; q++) {
                var a = reader[q], b = written[q];
                if (!(a === b || (Number.isNaN(a) && Number.isNaN(b)))) same = false;
              }
              out.live.bufferWrite = {
                getChannelDataSameReference: buf.getChannelData(0) === cd,
                copyFromChannelPreservesWrites: same,
                writtenBits: Array.from(written).map(function (v) {
                  return '0x' + f32Bits(v).toString(16).padStart(8, '0');
                }),
                readBits: Array.from(reader).map(function (v) {
                  return '0x' + f32Bits(v).toString(16).padStart(8, '0');
                }),
                silentChannelBits: (function () {
                  var zeros = new Float32Array(6);
                  buf.copyFromChannel(zeros, 1, 0);
                  return Array.from(zeros).map(function (v) {
                    return '0x' + f32Bits(v).toString(16).padStart(8, '0');
                  });
                })()
              };
              return out;
            });
          });
        });
      });
    });
  });
}

/* ------------------------------ 字体组 ------------------------------ */

var FAMILY_PROBE_STRINGS = {
  'Segoe UI Emoji': '☀☎✈❤',
  'Segoe UI Symbol': '★♠①⅓',
  'Microsoft YaHei': '永固中文测量'
};

function fontsGroup() {
  return Promise.resolve().then(function () {
    var out = {};
    var measurer = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    var DEFAULT_TEXT = 'MmWw0IlO.';
    function widthOf(font, text) {
      measurer.font = font;
      return measurer.measureText(text || DEFAULT_TEXT).width;
    }
    function probeString(family) { return FAMILY_PROBE_STRINGS[family] || DEFAULT_TEXT; }
    function familyWidth(family) { return widthOf('32px "' + family + '"', probeString(family)); }

    out.missingFallbackWidth = widthOf('32px IrisMissingFontXYZ');
    out.families = {};
    EXPECTATIONS.allowedFamilies.forEach(function (f) {
      out.families[f] = {
        width: familyWidth(f),
        documentFontsCheck: document.fonts.check('32px "' + f + '"'),
        probeString: probeString(f)
      };
    });
    out.disallowedCandidates = {};
    EXPECTATIONS.installedDisallowedCandidates.forEach(function (f) {
      out.disallowedCandidates[f] = {
        width: familyWidth(f),
        documentFontsCheck: document.fonts.check('32px "' + f + '"'),
        widthEqualsFallback: familyWidth(f) === out.missingFallbackWidth
      };
    });
    // document.fonts.check 只检查加载状态，不能证明系统中是否存在该字体。
    // FontFace local() 真正走本地字体选择；不加入 FontFaceSet，不改变页面排版。
    var localLoads = EXPECTATIONS.allowedFamilies.concat(EXPECTATIONS.installedDisallowedCandidates)
      .map(function (family, index) {
        var entry = out.families[family] || out.disallowedCandidates[family];
        var face = new FontFace('IrisLocalProbe' + index, 'local(' + JSON.stringify(family) + ')');
        return face.load().then(function () {
          entry.localLoad = { loaded: true, status: face.status };
        }, function (error) {
          entry.localLoad = { loaded: false, status: face.status, error: error.name };
        });
      });
    out.genericFamilies = {};
    ['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'math'].forEach(function (g) {
      out.genericFamilies[g] = widthOf('32px ' + g);
    });

    /* DOM/CSS 路径：实际布局宽度，不把 Canvas 的泛型回退当作 DOM 预期。 */
    var host = document.createElement('div');
    host.style.cssText = 'position:absolute;left:-99999px;top:0;visibility:hidden;white-space:nowrap;';
    document.body.appendChild(host);
    function spanWidth(fontFamily) {
      var span = document.createElement('span');
      span.style.cssText = 'font-family:' + fontFamily + ';font-size:32px;';
      span.textContent = DEFAULT_TEXT;
      host.appendChild(span);
      var w = span.getBoundingClientRect().width;
      host.removeChild(span);
      return w;
    }
    out.cssSpan = {
      arial: spanWidth('Arial'),
      verdana: spanWidth('Verdana'),
      georgia: spanWidth('Georgia'),
      georgiaWithFallback: spanWidth('"Georgia", monospace'),
      serif: spanWidth('serif'),
      sansSerif: spanWidth('sans-serif'),
      monospace: spanWidth('monospace'),
      cursive: spanWidth('cursive'),
      fantasy: spanWidth('fantasy'),
      serifWithFallback: spanWidth('serif, Verdana'),
      missing: spanWidth('IrisMissingFontXYZ')
    };
    document.body.removeChild(host);

    /* 远程 web font（Ahem：每字形前进 1em） */
    var style = document.createElement('style');
    style.textContent = '@font-face{font-family:\'IrisAhem\';src:url(\'/fonts/Ahem.ttf\') format(\'truetype\');}';
    document.head.appendChild(style);
    var before = widthOf('100px IrisAhem', 'XXXX');
    function runLocalFontAccess() {
      if (typeof queryLocalFonts !== 'function') {
        out.localFontAccess = { supported: false, reason: 'queryLocalFonts 不存在' };
        return Promise.resolve(out);
      }
      return withTimeout(queryLocalFonts(), 8000, 'queryLocalFonts').then(function (fonts) {
        var families = fonts.map(function (f) {
          return { family: f.family, postscriptName: f.postscriptName === undefined ? null : f.postscriptName,
                   style: f.style === undefined ? null : f.style, weight: f.weight === undefined ? null : f.weight };
        });
        var names = Array.from(new Set(families.map(function (f) { return f.family; }))).sort();
        var nameSet = {};
        names.forEach(function (n) { nameSet[n.toLowerCase()] = true; });
        out.localFontAccess = {
          supported: true, count: fonts.length,
          uniqueFamilyCount: names.length,
          families: names, entries: families,
          allowlistMissing: EXPECTATIONS.allowedFamilies.filter(function (f) {
            return !nameSet[f.toLowerCase()];
          }),
          disallowedCandidatesPresent: EXPECTATIONS.installedDisallowedCandidates.filter(function (f) {
            return nameSet[f.toLowerCase()];
          })
        };
        return out;
      }, function (err) {
        out.localFontAccess = { supported: true, error: String(err && err.message || err) };
        return out;
      });
    }
    var webFontLoad = withTimeout(document.fonts.load('100px IrisAhem', 'XXXX'), 8000, 'webfont-load')
      .then(function () {
        var after = widthOf('100px IrisAhem', 'XXXX');
        out.webFont = {
          family: 'IrisAhem',
          url: EXPECTATIONS.webFont.url,
          widthBeforeLoad: before,
          widthAfterLoad: after,
          expectedAdvancePx: 4 * 100,
          documentFontsCheck: document.fonts.check('100px IrisAhem'),
          status: document.fonts.status
        };
        return runLocalFontAccess();
      }, function (err) {
        /* web font 超时/失败：保留证据，queryLocalFonts 独立继续测量。 */
        out.webFont = { family: 'IrisAhem', error: String(err && err.message || err) };
        return runLocalFontAccess();
      });
    return Promise.all([webFontLoad, Promise.all(localLoads)]).then(function () { return out; });
  });
}

/* ------------------------------ WebRTC 组 ------------------------------ */

function webrtcGroup() {
  return new Promise(function (resolve) {
    var out = { configuredServers: [], iceTransportPolicy: 'all' };
    var pc;
    try { pc = new RTCPeerConnection({ iceServers: [] }); }
    catch (e) { out.error = 'RTCPeerConnection 构造失败: ' + (e && e.message || e); resolve(out); return; }
    var candidates = [];
    var rawCandidates = [];
    function pick(c) {
      return {
        type: c.type, protocol: c.protocol,
        address: c.address || c.ip || null,
        port: c.port, relayProtocol: c.relayProtocol || null,
        isMdns: typeof (c.address || c.ip) === 'string' && (c.address || c.ip).endsWith('.local')
      };
    }
    var done = new Promise(function (res) {
      pc.addEventListener('icecandidate', function (e) {
        if (e.candidate) {
          candidates.push(pick(e.candidate));
          if (rawCandidates.length < 8) rawCandidates.push(e.candidate.candidate);
        } else res('no-more-candidates');
      });
      pc.addEventListener('icegatheringstatechange', function () {
        if (pc.iceGatheringState === 'complete') res('complete');
      });
    });
    pc.createDataChannel('iris-probe');
    pc.createOffer().then(function (offer) {
      return pc.setLocalDescription(offer);
    }).then(function () {
      return withTimeout(done, 6000, 'ice-gathering').catch(function () { return 'timeout'; });
    }).then(function (state) {
      function isLoopback(addr) {
        return addr === 'localhost' || /^127\./.test(addr) || addr === '::1' || /^::ffff:127\./.test(addr);
      }
      var leaks = candidates.filter(function (c) {
        return !c.isMdns && !(typeof c.address === 'string' && isLoopback(c.address));
      });
      out.gathering = {
        finalState: state,
        iceGatheringState: pc.iceGatheringState,
        candidateCount: candidates.length,
        candidates: candidates,
        firstRawCandidates: rawCandidates,
        srflxOrRelayCount: candidates.filter(function (c) {
          return c.type === 'srflx' || c.type === 'relay';
        }).length,
        nonLoopbackLiteralCount: leaks.length,
        leakSamples: leaks.slice(0, 4)
      };
      try { pc.close(); out.closed = true; } catch (e) { out.closed = false; }
      resolve(out);
    }, function (err) {
      out.error = String(err && err.message || err);
      try { pc.close(); } catch (e) {}
      resolve(out);
    });
  });
}

/* ------------------------------ 网络组 ------------------------------ */

function parseChBrandList(value) {
  if (typeof value !== 'string') return null;
  return value.split(',').map(function (part) {
    var m = part.trim().match(/^"([^"]*)";\s*v="?([^"]*)"?(?:;\s*v="?([^"]*)"?)?$/);
    return m ? [m[1], m[2]] : null;
  }).filter(Boolean).sort(function (a, b) { return a[0] < b[0] ? -1 : 1; });
}

function networkGroup() {
  return Promise.resolve().then(function () {
    var out = {};
    function fetchJson(url) {
      return withTimeout(fetch(url).then(function (r) {
        return r.json().then(function (j) { return { status: r.status, body: j }; });
      }), 6000, 'fetch-' + url);
    }
    return Promise.all([
      fetchJson('/echo'), fetchJson('/accept-ch'), fetchJson('/echo'),
      withTimeout(fetch('/redirect', { redirect: 'follow' }).then(function (r) {
        return r.json().then(function (j) {
          return { status: r.status, redirected: r.redirected, url: r.url, body: j };
        });
      }), 6000, 'fetch-/redirect'),
      highEntropySample()
    ]).then(function (results) {
      out.echoBeforeAcceptCh = results[0];
      out.acceptCh = results[1];
      out.echoAfterAcceptCh = results[2];
      out.redirect = results[3];
      var jsHigh = results[4];
      out.jsHighEntropy = jsHigh;
      var h1 = (results[0].body.headers || {});
      var h2 = (results[2].body.headers || {});
      var hr = (results[3].body.headers || {});
      var comparisons = {
        echoUserAgentMatchesJs: h1['user-agent'] === navigator.userAgent,
        echoAfterAcceptChUserAgentMatchesJs: h2['user-agent'] === navigator.userAgent,
        redirectUserAgentMatchesJs: hr['user-agent'] === navigator.userAgent,
        fullVersionListHeaderVsJs: null,
        highEntropyFields: {}
      };
      var headerList = parseChBrandList(h2['sec-ch-ua-full-version-list']);
      if (headerList && jsHigh.values && jsHigh.values.fullVersionList) {
        var jsList = jsHigh.values.fullVersionList.map(function (e) { return [e.brand, e.version]; })
          .sort(function (a, b) { return a[0] < b[0] ? -1 : 1; });
        comparisons.fullVersionListHeaderVsJs = JSON.stringify(headerList) === JSON.stringify(jsList);
        comparisons.headerFullVersionList = headerList;
        comparisons.jsFullVersionList = jsList;
      }
      var fieldMap = {
        'sec-ch-ua-platform-version': ['platformVersion', String],
        'sec-ch-ua-arch': ['architecture', String],
        'sec-ch-ua-bitness': ['bitness', String],
        'sec-ch-ua-model': ['model', String],
        'sec-ch-ua-full-version': ['uaFullVersion', String],
        'sec-ch-ua-platform': [null, null],
        'sec-ch-ua-wow64': ['wow64', function (v) { return v === true || v === '?1' ? '?1' : '?0'; }],
        'device-memory': [null, null]
      };
      Object.keys(fieldMap).forEach(function (header) {
        var key = fieldMap[header][0], conv = fieldMap[header][1];
        if (!key) {
          comparisons.highEntropyFields[header] = { headerValue: h2[header] === undefined ? null : h2[header] };
          return;
        }
        var jsValue = jsHigh.values ? jsHigh.values[key] : undefined;
        var jsNorm = jsValue === undefined ? null : (conv ? conv(jsValue) : jsValue);
        var headerRaw = h2[header] === undefined ? null : h2[header];
        // UA-CH 字符串是带引号的 Structured Field；raw 保留线上的原值。
        var headerNorm = headerRaw === null || header === 'sec-ch-ua-wow64' ?
          headerRaw : JSON.parse(headerRaw);
        /* 空字符串 / 假值 hint（桌面 model=""、wow64=false）Chromium 可能不发送：
           头部缺席且 JS 值为空/假 视为一致；非空值必须逐字相等。 */
        var matches;
        if (jsNorm === '' || jsNorm === '?0' || jsNorm === false) {
          matches = headerNorm === null || headerNorm === jsNorm;
        } else {
          matches = headerNorm !== null && headerNorm === String(jsNorm);
        }
        comparisons.highEntropyFields[header] = {
          headerValue: headerRaw, parsedHeaderValue: headerNorm, jsValue: jsNorm, matches: matches
        };
      });
      comparisons.highEntropyFields['device-memory'].jsValue =
        typeof navigator.deviceMemory === 'number' ? String(navigator.deviceMemory) : null;
      comparisons.highEntropyFields['device-memory'].matches =
        h2['device-memory'] === comparisons.highEntropyFields['device-memory'].jsValue;
      comparisons.highEntropyFields['sec-ch-ua-platform'].jsValue =
        navigator.userAgentData ? navigator.userAgentData.platform : null;
      comparisons.highEntropyFields['sec-ch-ua-platform'].matches =
        h2['sec-ch-ua-platform'] !== undefined &&
        JSON.parse(h2['sec-ch-ua-platform']) === comparisons.highEntropyFields['sec-ch-ua-platform'].jsValue;
      out.comparisons = comparisons;
      var before = Object.keys(h1).filter(function (k) { return k.indexOf('sec-ch-ua-full') === 0 || k === 'device-memory'; });
      var after = Object.keys(h2).filter(function (k) { return k.indexOf('sec-ch-ua-full') === 0 || k === 'device-memory'; });
      out.highEntropyHeaderDelta = { beforeAcceptCh: before.sort(), afterAcceptCh: after.sort() };
      out.navigationRequestUserAgent = (window.irisFirstSample &&
        window.irisFirstSample.navigationRequest &&
        window.irisFirstSample.navigationRequest.headers &&
        window.irisFirstSample.navigationRequest.headers['user-agent']) || null;
      out.navigationUserAgentMatchesJs = out.navigationRequestUserAgent === navigator.userAgent;
      return out;
    });
  });
}

/* ------------------------------ checks ------------------------------ */

function buildChecks(report) {
  var raw = report.raw;
  var checks = [];
  function add(id, passed, detail, unsupported) {
    checks.push({ id: id, passed: passed === true,
      status: passed === true ? 'passed' : unsupported === true ? 'unsupported' : 'failed',
      detail: detail == null ? null : String(detail) });
  }
  function groupOk(name) { return raw[name] && !raw[name].error && !raw[name].timeout; }

  /* 1. 导航请求注入与 UA 一致 */
  var first = raw.firstScript || {};
  var navHeaders = first.navigationRequest && first.navigationRequest.headers;
  add('navigation-request-user-agent',
    !!(navHeaders && navHeaders['user-agent'] &&
       navHeaders['user-agent'] === (first.navigator && first.navigator.userAgent)),
    !navHeaders ? '导航请求 JSON 缺失' :
      (navHeaders['user-agent'] ? '请求头 UA 与 navigator.userAgent 一致性' : '导航请求缺少 user-agent 头'));

  /* 2. 原生 getter 描述符与 webdriver 暴露 */
  var d = first.descriptors || {};
  var nativeRequired = ['userAgent', 'appVersion', 'platform', 'language', 'languages',
    'hardwareConcurrency', 'deviceMemory', 'maxTouchPoints', 'userAgentData', 'webdriver'];
  var nativeBad = nativeRequired.filter(function (k) {
    var e = d['Navigator.prototype.' + k];
    return !e || !e.present || !e.hasGetter || !e.nativeCode;
  });
  var wd = first.webdriver || {};
  var webdriverNativeFalse = wd.typeofValue === 'boolean' && wd.value === false &&
    wd.inNavigator === true && wd.descriptorOnNavigatorPrototype === true &&
    wd.descriptorOnNavigatorInstance === false;
  add('native-getter-descriptors', nativeBad.length === 0 && webdriverNativeFalse,
    nativeBad.length ? '非原生 getter: ' + nativeBad.join(',') :
      (webdriverNativeFalse ? '身份 getter 均为原型原生 getter；webdriver=false' : 'webdriver 暴露状态: ' + JSON.stringify(wd)));

  /* 3. 跨上下文身份一致 */
  var matrix = (raw.contexts && raw.contexts.identityMatrix) || {};
  // webdriver 属于 Navigator，不属于 WorkerNavigator；分别验证其暴露契约。
  var unequalFields = Object.keys(matrix).filter(function (f) { return f !== 'webdriverPresent' && matrix[f].equal === false; });
  var contextSamples = (raw.contexts && raw.contexts.contexts) || {};
  Object.keys(contextSamples).forEach(function (name) {
    var entry = contextSamples[name];
    var sample = name === 'window' ? entry : entry && (entry.sample || entry.report);
    if (!sample) return;
    var observed = sample.webdriver || {};
    var worker = /Worker$/.test(name);
    if (observed.present !== !worker || observed.typeofValue !== (worker ? 'undefined' : 'boolean') ||
        observed.value !== (worker ? null : false)) unequalFields.push(name + '.webdriver');
  });
  var nullFields = Object.keys(matrix).filter(function (f) { return matrix[f].equal === null; });
  var available = (raw.contexts && raw.contexts.availableContexts) || [];
  add('cross-context-identity',
    available.length >= 2 && unequalFields.length === 0 && nullFields.length === 0,
    '可用上下文: ' + available.join(',') +
      (unequalFields.length ? '；不一致字段: ' + unequalFields.join(',') : '') +
      (nullFields.length ? '；无法比较字段: ' + nullFields.join(',') : ''));

  /* 4. 时区一致性 */
  var tzOk = groupOk('timezone');
  var tzUnequal = [];
  if (raw.contexts) {
    var wtz = raw.contexts.contexts.window && raw.contexts.contexts.window.timezone;
    ['sameOriginIframe', 'crossSiteIframe', 'dedicatedWorker', 'sharedWorker', 'serviceWorker'].forEach(function (k) {
      var ctx = raw.contexts.contexts[k];
      var s = ctx && (ctx.sample || ctx.report);
      var tz = s && s.timezone;
      if (!tz) return;
      if (!wtz ||
        tz.offsetWinterMinutes !== wtz.offsetWinterMinutes ||
        tz.offsetSummerMinutes !== wtz.offsetSummerMinutes ||
        tz.resolvedTimeZone !== wtz.resolvedTimeZone) tzUnequal.push(k);
    });
  }
  add('timezone-consistency', tzOk && tzUnequal.length === 0,
    tzUnequal.length ? '时区不一致上下文: ' + tzUnequal.join(',') : '冬/夏偏移与 Intl 时区跨上下文一致');

  /* 5. 屏幕一致性 */
  var scr = raw.screen;
  var screenOk = false, screenDetail = 'screen 组未完成';
  if (scr && !scr.error) {
    var structural = scr.availWidth <= scr.width && scr.availHeight <= scr.height &&
      scr.colorDepth === scr.pixelDepth &&
      scr.matchMedia.resolution && scr.matchMedia.resolution.matches === true &&
      scr.matchMedia.orientationLandscape !== null &&
      scr.matchMedia.orientationLandscape ===
        ((scr.orientation && scr.orientation.type || '').indexOf('landscape') === 0);
    var iframesMatch = true, iframesChecked = 0;
    ['sameOriginIframe', 'crossSiteIframe'].forEach(function (k) {
      var ctx = raw.contexts && raw.contexts.contexts[k];
      var s = ctx && ctx.sample;
      if (!s || !s.screen) return;
      iframesChecked++;
      var f = s.screen;
      if (f.width !== scr.width || f.height !== scr.height || f.availWidth !== scr.availWidth ||
        f.availHeight !== scr.availHeight || f.colorDepth !== scr.colorDepth ||
        f.devicePixelRatio !== scr.devicePixelRatio) iframesMatch = false;
    });
    screenOk = structural && iframesMatch;
    screenDetail = '结构约束=' + structural + '；iframe 屏幕=' + iframesMatch +
      '（对比了 ' + iframesChecked + ' 个 iframe）';
  }
  add('screen-consistency', screenOk, screenDetail);

  /* 6. WebGL 身份与 capability */
  var webglOk = false, webglDetail = 'webgl 组未完成';
  var wg = raw.webgl;
  if (wg && !wg.error) {
    var idsOk = wg.webgl1 && wg.webgl2 && wg.webgl1.supported && wg.webgl2.supported &&
      typeof wg.webgl1.unmaskedVendor === 'string' && wg.webgl1.unmaskedVendor.length > 0 &&
      typeof wg.webgl1.unmaskedRenderer === 'string' && wg.webgl1.unmaskedRenderer.length > 0 &&
      typeof wg.webgl2.unmaskedRenderer === 'string' && wg.webgl2.unmaskedRenderer.length > 0 &&
      typeof wg.webgl1.version === 'string' && wg.webgl1.version.length > 0;
    var roundtrip1 = wg.webgl1 && wg.webgl1.clearRoundtrip && wg.webgl1.clearRoundtrip.beyondTolerance === 0;
    var roundtrip2 = wg.readback && wg.readback.clearTolerance && wg.readback.clearTolerance.beyondTolerance === 0;
    webglOk = !!idsOk && !!roundtrip1 && !!roundtrip2;
    webglDetail = '身份字符串与双上下文 clear 读回（容差 ±1）；' +
      'webgl1 超差=' + (wg.webgl1 && wg.webgl1.clearRoundtrip ? wg.webgl1.clearRoundtrip.beyondTolerance : 'n/a') +
      '，webgl2 超差=' + (wg.readback && wg.readback.clearTolerance ? wg.readback.clearTolerance.beyondTolerance : 'n/a');
  }
  add('webgl-capability', webglOk, webglDetail);
  var transferred = report.raw.transferredWebgl;
  add('transferred-webgl-alpha', !!(transferred && !transferred.error &&
    ['webgl', 'webgl2'].every(function (kind) {
      var item = transferred[kind];
      return item && item.error === 0 && item.alphaPreserved &&
        item.attributes.premultipliedAlpha === false &&
        item.placeholder.hardMismatches === 0 && item.workerPng.hardMismatches === 0;
    })), '真实 worker GLSL 渲染；未预乘半透明 framebuffer、worker PNG、placeholder PNG 同一字节');

  /* 7. WebGL 读回一致性 */
  var rb = wg && wg.readback;
  var rgbOk = rb && rb.rgbPacking && (rb.rgbPacking.supported ?
    rb.rgbPacking.align1EqualsAlign4 && rb.rgbPacking.rgbMatchesRgbaChannels :
    rb.rgbPacking.rejectedWithoutMutation);
  var readbackOk = !!(rb && rb.cropMatchesFull && rb.repeatIdentical && rb.pboMatchesTyped &&
    rb.pboOffsetMatchesTyped && rb.getBufferSubDataDstOffset && rb.getBufferSubDataDstOffset.matches &&
    rb.getBufferSubDataDstOffset.prefixIntact && rb.basicError.count === 0 && rgbOk &&
    rb.rgbaPacking && rb.rgbaPacking.error.count === 0 && rb.rgbaPacking.matches && rb.rgbaPacking.paddingIntact &&
    rb.rowLength && rb.rowLength.matchesCrop && rb.rowLength.error.count === 0 &&
    rb.skipPixelsRows && rb.skipPixelsRows.matchesCrop && rb.float && rb.float.extAvailable &&
    rb.skipPixelsRows.error.count === 0 && rb.float.framebufferComplete &&
    rb.float.pboTypedMismatch === 0 && rb.float.samplesCompared === 256 &&
    rb.float.typedError.count === 0 && rb.float.pboError.count === 0 &&
    (rb.float.maxUlpFromClear === 0 || rb.float.maxUlpFromClear === 1));
  add('webgl-readback-consistency', readbackOk, rb ?
    'crop/full、repeat、PBO==typed、dstOffset、RGB 原生支持/拒绝、RGBA alignment=8、rowLength/skip、FLOAT(±1 ULP)' :
    'webgl2 读回矩阵未执行');

  /* 7b. WebGL 序列化 domain：PNG 序列化字节（ImageDecoder 原始解码）== 同一快照
         的直接 readPixels（同 WebGL domain，不经 2D canvas 二次路径）。 */
  var ser = rb && rb.serialization;
  var serOk = !!(ser && !ser.error && ser.png && ser.png.magic === '89504e470d0a1a0a' &&
    ser.rawDecode && ser.rawDecode.supported === true &&
    ser.serializedMatchesSnapshot && ser.serializedMatchesSnapshot.hardMismatches === 0);
  add('webgl-serialization-domain', serOk, ser ?
    (ser.error ? '序列化失败: ' + ser.error :
      'PNG 序列化原始字节与 readPixels 快照逐字节一致=' +
      (ser.serializedMatchesSnapshot ? ser.serializedMatchesSnapshot.hardMismatches === 0 : 'n/a') +
      '；rawDecode=' + (ser.rawDecode && ser.rawDecode.supported === true ?
        ser.rawDecode.format : (ser.rawDecode && (ser.rawDecode.error || '不支持')))) :
    'WebGL 序列化未执行');

  /* 8. 普通 buffer 隔离 */
  var buf = wg && wg.buffers;
  add('webgl-buffer-isolation',
    !!(buf && buf.plainUnchanged && buf.readbackSeen && buf.overwriteClearsReadback &&
      buf.copyPreserved && buf.partialOverwrite && buf.partialOverwrite.headPreserved &&
      buf.partialOverwrite.tailMatches && buf.copyError.count === 0 &&
      buf.byteOverwrite.matches && buf.byteOverwrite.error.count === 0 &&
      buf.byteCopy.matches && buf.byteCopy.error.count === 0 &&
      buf.failedMutations.readError.last === 0x502 && buf.failedMutations.writeError.last === 0x501 &&
      buf.failedMutations.copyError.last === 0x501 && buf.failedMutations.finalError.count === 0 &&
      buf.failedMutations.sourceUnchanged && buf.failedMutations.destinationUnchanged),
    buf ? '普通 buffer 不变；像素/字节级覆盖与复制；失败写入不改变数据或来源信息' : 'buffer 语义未执行');

  /* 9. 错误语义 */
  var er = wg && wg.errors;
  var invalidEnum = 0x0500, invalidValue = 0x0501, invalidOp = 0x0502;
  add('webgl-error-semantics', !!(er &&
    er.incompatibleFormatType && !er.incompatibleFormatType.threw &&
    er.incompatibleFormatType.error.last === invalidOp &&
    er.invalidAlignment && !er.invalidAlignment.threw && er.invalidAlignment.error.last === invalidValue &&
    er.getBufferSubDataOutOfRange && !er.getBufferSubDataOutOfRange.threw &&
    er.getBufferSubDataOutOfRange.error.last === invalidValue &&
    er.shaderCompile && er.shaderCompile.statusFalse && er.shaderCompile.infoLogNonEmpty &&
    er.programLink && er.programLink.statusFalse),
    er ? '非法组合返回 GL 错误码（不抛异常）；坏 shader 编译失败且有日志' : '错误语义未执行');

  /* 10. Canvas 2D 语义 */
  var c2 = raw.canvas2d;
  var workerCanvas = raw.contexts && raw.contexts.contexts.dedicatedWorker &&
    raw.contexts.contexts.dedicatedWorker.report &&
    raw.contexts.contexts.dedicatedWorker.report.offscreenCanvas;
  var sharedWorkerCanvas = raw.contexts && raw.contexts.contexts.sharedWorker &&
    raw.contexts.contexts.sharedWorker.report &&
    raw.contexts.contexts.sharedWorker.report.offscreenCanvas;
  var canvasOk = !!(c2 && !c2.error && c2.geometry && c2.geometry.cropMatchesFull &&
    c2.geometry.repeatIdentical &&
    c2.toDataURL && c2.toDataURL.rawDecodeVsGetImageData &&
    c2.toDataURL.rawDecodeVsGetImageData.hardMismatches === 0 &&
    c2.toBlob && c2.toBlob.rawDecodeVsGetImageData &&
    c2.toBlob.rawDecodeVsGetImageData.hardMismatches === 0 &&
    c2.offscreen && c2.offscreen.decodedMatchesDirect);
  var workerMatches = false;
  if (workerCanvas && workerCanvas.pixelDigest && c2 && c2.offscreen) {
    workerMatches = workerCanvas.pixelDigest === c2.offscreen.pixelDigest &&
      workerCanvas.png && workerCanvas.png.digest === c2.offscreen.png.digest &&
      workerCanvas.decodedPixelDigest === workerCanvas.pixelDigest;
  }
  var sharedWorkerMatches = !!(sharedWorkerCanvas && c2 && c2.offscreen &&
    sharedWorkerCanvas.pixelDigest === c2.offscreen.pixelDigest &&
    sharedWorkerCanvas.png && sharedWorkerCanvas.png.digest === c2.offscreen.png.digest);
  add('canvas2d-semantics', canvasOk && workerMatches && sharedWorkerMatches,
    (c2 ? 'crop/full、repeat、toDataURL/toBlob 序列化字节(ImageDecoder 原始解码)==getImageData' : 'canvas2d 未执行') +
    (workerCanvas ? '；DedicatedWorker 同绘制摘要一致=' + workerMatches : '；worker 画布数据缺失') +
    '；SharedWorker generic font 与同绘制摘要一致=' + sharedWorkerMatches);

  /* 11. 错误与 taint */
  var cerr = c2 && c2.errors;
  add('canvas-errors-taint', !!(cerr &&
    cerr.emptySizeGetImageData && cerr.emptySizeGetImageData.threw &&
    cerr.zeroSizeToDataURL && cerr.zeroSizeToDataURL.value === 'data:,' &&
    cerr.outOfBoundsCrop && !cerr.outOfBoundsCrop.threw &&
    cerr.outOfBoundsCrop.insideMatches && cerr.outOfBoundsCrop.outsideTransparent &&
    cerr.taint && cerr.taint.getImageData && cerr.taint.getImageData.threw &&
    cerr.taint.getImageData.name === 'SecurityError'),
    cerr ? '空尺寸 IndexSizeError；0×0 toDataURL="data:,"；越界裁剪语义；taint SecurityError' :
      'canvas 错误/taint 未执行');

  /* 12. float16 */
  var f16 = raw.float16;
  var float16Ok = !!(f16 && !f16.error && f16.attributes && f16.attributes.colorType === 'float16' &&
    f16.baselinePixel && f16.baselinePixel.repeatIdentical &&
    f16.regionPixel && f16.regionPixel.regionEqualsFullSlice &&
    f16.png && f16.png.bitDepth === 16 &&
    f16.png.magic === '89504e470d0a1a0a' && f16.png.length > 0);
  add('float16-canvas', float16Ok, f16 ? ('colorType=float16 回读/区域/重复；PNG 位深度=' +
    (f16.png ? f16.png.bitDepth : 'n/a') + '；baseline LSB 偏移=' +
    (f16.baselinePixel ? f16.baselinePixel.lsbDeltaCount : 'n/a') + '（原始记录，不替代跨 seed 比较）') :
    'float16 不可用或未执行');

  /* 13/14. 音频 */
  var audio = raw.audio;
  var exp = EXPECTATIONS.offlineAudio;
  var offlineOk = !!(audio && !audio.error && audio.constructor &&
    audio.constructor.length === exp.length && audio.constructor.sampleRate === exp.sampleRate &&
    audio.render && audio.render.length === exp.length &&
    audio.render.sampleRate === exp.sampleRate && audio.render.duration === exp.duration &&
    audio.render.copyFromChannelMatches &&
    audio.render.channelDataDigest && audio.render.channelDataDigest === audio.render.repeatGetChannelDataDigest &&
    audio.render.channelDataDigest === audio.render.secondContextDigest);
  add('audio-offline-semantics', offlineOk, audio ?
    ('length/sampleRate/duration=' + (audio.constructor ? audio.constructor.length + '/' +
      audio.constructor.sampleRate + '/' + (audio.render && audio.render.duration) : 'n/a') +
      '；copyFromChannel==getChannelData；重复读取与第二上下文摘要一致') : 'audio 组未执行');
  var live = audio && audio.live;
  add('audio-live-buffer-writes', !!(live && live.bufferWrite &&
    live.bufferWrite.copyFromChannelPreservesWrites &&
    live.bufferWrite.writtenBits && live.bufferWrite.writtenBits[0] === live.bufferWrite.readBits[0] &&
    live.defaultSampleRate === exp.sampleRate &&
    live.explicitSampleRate && live.explicitSampleRate.actual === exp.sampleRate),
    live ? '用户写入（含 NaN/Infinity）经 copyFromChannel 原样保留；真实图使用 profile 采样率' : 'live buffer 未执行');
  add('audio-invalid-sample-rate', !!(audio && audio.invalidSampleRate &&
    ['live', 'offline'].every(function (kind) {
      var result = audio.invalidSampleRate[kind];
      return result && !result.accepted && result.error === 'NotSupportedError';
    })), '实时与离线上下文仍拒绝 sampleRate=0，不能用 profile 覆盖吞掉非法输入');

  /* 15. 字体 allowlist */
  var fonts = raw.fonts;
  var fontsOk = false, fontsDetail = 'fonts 组未完成';
  if (fonts && !fonts.error) {
    var fallback = fonts.missingFallbackWidth;
    var inactive = EXPECTATIONS.allowedFamilies.filter(function (f) {
      var e = fonts.families && fonts.families[f];
      var expectedLocal = EXPECTATIONS.nonUniqueLocalFamilies.indexOf(f) === -1;
      return !e || !e.localLoad || e.localLoad.loaded !== expectedLocal ||
        (!expectedLocal && e.localLoad.error !== 'NetworkError');
    });
    var notBlocked = EXPECTATIONS.installedDisallowedCandidates.filter(function (f) {
      var e = fonts.disallowedCandidates && fonts.disallowedCandidates[f];
      return !e || e.widthEqualsFallback !== true || !e.localLoad ||
        e.localLoad.loaded !== false || e.localLoad.status !== 'error';
    });
    var distinct = EXPECTATIONS.allowedFamilies.filter(function (f) {
      var e = fonts.families && fonts.families[f];
      return e && Math.abs(e.width - fallback) > 0.5;
    });
    fontsOk = inactive.length === 0 && notBlocked.length === 0 && distinct.length >= 4;
    fontsDetail = '家族名与 local() 唯一名称边界（异常: ' + (inactive.join(',') || '无') + '）；' +
      '已安装候选被阻止（异常: ' + (notBlocked.join(',') || '无') + '）；' +
      distinct.length + ' 个家族度量与回退可区分';
  }
  add('fonts-allowlist-blocking', fontsOk, fontsDetail);

  /* 16. web font */
  var wf = fonts && fonts.webFont;
  add('fonts-webfont', !!(wf && !wf.error && wf.documentFontsCheck === true &&
    Math.abs(wf.widthAfterLoad - wf.expectedAdvancePx) <= 1 &&
    wf.widthAfterLoad !== wf.widthBeforeLoad),
    wf ? (wf.error ? wf.error : 'Ahem 加载后 XXXX@100px ≈ 400px（实测 ' + wf.widthAfterLoad + '）') : 'web font 未执行');

  /* 17. queryLocalFonts */
  var lfa = fonts && fonts.localFontAccess;
  add('fonts-local-font-access',
    !!(lfa && lfa.supported && !lfa.error && Array.isArray(lfa.families) && lfa.families.length > 0 &&
      lfa.allowlistMissing && lfa.allowlistMissing.length === 0 &&
      lfa.disallowedCandidatesPresent && lfa.disallowedCandidatesPresent.length === 0),
    lfa ? (lfa.error ? 'queryLocalFonts 失败: ' + lfa.error :
      '唯一 family 数=' + lfa.uniqueFamilyCount + '；允许家族缺失: ' +
      (lfa.allowlistMissing || []).join(',') + '；候选泄漏: ' +
      (lfa.disallowedCandidatesPresent || []).join(',')) : 'queryLocalFonts 未执行');

  /* 18. WebRTC */
  var rtc = raw.webrtc;
  var rtcOk = false, rtcDetail = 'webrtc 组未完成';
  if (rtc && !rtc.error && rtc.gathering) {
    var g = rtc.gathering;
    rtcOk = g.nonLoopbackLiteralCount === 0 && g.srflxOrRelayCount === 0;
    rtcDetail = '候选 ' + g.candidateCount + ' 个（mDNS/loopback 之外字面量: ' +
      g.nonLoopbackLiteralCount + '，srflx/relay: ' + g.srflxOrRelayCount + '）；收集状态: ' + g.finalState;
  }
  add('webrtc-loopback-only', rtcOk, rtcDetail);

  /* 19. 网络一致性 */
  var net = raw.network;
  var cmp = net && net.comparisons;
  var heFieldsOk = cmp && Object.keys(cmp.highEntropyFields).every(function (h) {
    var e = cmp.highEntropyFields[h];
    return e.matches === true;
  });
  add('network-header-consistency', !!(net && !net.error && cmp &&
    cmp.echoUserAgentMatchesJs && cmp.echoAfterAcceptChUserAgentMatchesJs &&
    cmp.redirectUserAgentMatchesJs && net.navigationUserAgentMatchesJs &&
    cmp.fullVersionListHeaderVsJs === true && heFieldsOk &&
    net.redirect && net.redirect.url && net.redirect.url.indexOf('/echo?redirected=1') !== -1),
    net ? ('UA 头==JS UA（含导航/echo/redirect）；高熵头与 getHighEntropyValues 一致=' +
      (heFieldsOk === true) + '；fullVersionList 一致=' + (cmp.fullVersionListHeaderVsJs === true)) :
      'network 组未执行');

  /* WebGPU 标准不可用不算通过；实际 request/render 错误仍使验收失败。 */
  var gpu = raw.webgpu;
  var gpuUnavailable = !!(gpu && gpu.supported === false && !gpu.error && !gpu.timeout &&
    (gpu.unavailable === 'api-unavailable' || gpu.unavailable === 'adapter-unavailable'));
  add('webgpu-adapter-metadata',
    !!(gpu && gpu.supported && gpu.adapterInfo && typeof gpu.adapterInfo.vendor === 'string' &&
      gpu.adapterInfo.vendor.length > 0 && gpu.limits && typeof gpu.limits.maxTextureDimension2D === 'number' &&
      Array.isArray(gpu.features)),
    gpu ? (gpu.supported ? 'adapter.info/limits/features 已记录（原始数据见 raw.webgpu）' :
      'WebGPU 不可用: ' + (gpu.reason || gpu.error)) : 'webgpu 组未执行', gpuUnavailable);
  var gpuPixels = gpu && gpu.render && gpu.render.rgba;
  var gpuColor = [51, 102, 153, 255];
  add('webgpu-render',
    !!(gpu && !gpu.error && !gpu.validationError && Array.isArray(gpuPixels) && gpuPixels.length === 256 &&
      gpuPixels.every(function (value, i) { return value === gpuColor[i % 4]; })),
    gpuUnavailable ? gpu.reason : '真实 WGSL 三角形 → RGBA8 texture → mapAsync；不对 WebGPU buffer 添加扰动',
    gpuUnavailable);

  return checks;
}

/* ------------------------------ 渲染 ------------------------------ */

function renderSection(sectionId, preId, data) {
  var pre = document.getElementById(preId);
  if (pre) pre.textContent = JSON.stringify(data, null, 1);
  var sec = document.getElementById(sectionId);
  var failed = data && (data.error || data.timeout);
  if (sec) sec.className = failed ? 'error' : '';
}

function renderChecks(checks) {
  var host = document.getElementById('checks-host');
  if (!host) return;
  var table = document.createElement('table');
  table.className = 'checks';
  var head = document.createElement('tr');
  ['检查项', '状态', '说明'].forEach(function (t) {
    var th = document.createElement('th'); th.textContent = t; head.appendChild(th);
  });
  var thead = document.createElement('thead'); thead.appendChild(head); table.appendChild(thead);
  var tbody = document.createElement('tbody');
  checks.forEach(function (c) {
    var tr = document.createElement('tr');
    var tdId = document.createElement('td'); tdId.textContent = c.id;
    var tdSt = document.createElement('td');
    tdSt.className = 'st ' + (c.passed ? 'pass' : c.status === 'unsupported' ? '' : 'fail');
    tdSt.textContent = c.passed ? '通过' : c.status === 'unsupported' ? '不支持（非必需）' : '失败';
    var tdNote = document.createElement('td'); tdNote.textContent = c.detail || '';
    tr.appendChild(tdId); tr.appendChild(tdSt); tr.appendChild(tdNote);
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  host.textContent = '';
  host.appendChild(table);
}

/* ------------------------------ 清理 ------------------------------ */

async function cleanup() {
  var state = { errors: [] };
  state.dedicatedWorkersTerminated = 0;
  resources.workers.forEach(function (w) {
    try { w.terminate(); state.dedicatedWorkersTerminated++; }
    catch (e) { state.errors.push('worker: ' + String(e)); }
  });
  state.sharedWorkerPortsClosed = 0;
  resources.sharedPorts.forEach(function (p) {
    try { p.close(); state.sharedWorkerPortsClosed++; }
    catch (e) { state.errors.push('shared worker: ' + String(e)); }
  });
  state.iframesRemoved = 0;
  resources.iframes.forEach(function (f) {
    try { if (f.parentNode) f.parentNode.removeChild(f); state.iframesRemoved++; }
    catch (e) { state.errors.push('iframe: ' + String(e)); }
  });
  state.audioContextsClosed = 0;
  var releases = resources.audioContexts.map(async function (c) {
    try { await c.close(); state.audioContextsClosed++; }
    catch (e) { state.errors.push('audio: ' + String(e)); }
  });
  state.glContextLossRequested = 0;
  resources.glContexts.forEach(function (entry) {
    try {
      var ext = entry.gl.getExtension('WEBGL_lose_context');
      if (ext) { ext.loseContext(); state.glContextLossRequested++; }
    } catch (e) { state.errors.push('webgl: ' + String(e)); }
  });
  state.blobUrlsRevoked = 0;
  resources.blobUrls.forEach(function (u) {
    try { URL.revokeObjectURL(u); state.blobUrlsRevoked++; }
    catch (e) { state.errors.push('blob URL: ' + String(e)); }
  });
  state.serviceWorkerUnregister = null;
  if (resources.serviceWorker && resources.serviceWorker.unregister) {
    state.serviceWorkerUnregister = { started: true, result: null };
    releases.push((async function () {
      try {
        state.serviceWorkerUnregister.result = await resources.serviceWorker.unregister();
        if (!state.serviceWorkerUnregister.result) state.errors.push('service worker: registration missing');
      } catch (e) {
        state.serviceWorkerUnregister.result = false;
        state.errors.push('service worker: ' + String(e));
      }
    })());
  }
  await Promise.all(releases);
  return state;
}

/* ------------------------------ 主流程 ------------------------------ */

function run() {
  var report = {
    fixture: 'iris-demo-probe/1',
    startedAt: new Date().toISOString(),
    page: { href: location.href, origin: location.origin, protocol: location.protocol },
    expectations: EXPECTATIONS,
    raw: {},
    checks: [],
    cleanup: null
  };
  var groups = [
    ['firstScript', function () { return window.irisFirstSample || { error: '首脚本采样缺失' }; }, 3000],
    ['contexts', contextsGroup, 16000],
    ['timezone', timezoneGroup, 3000],
    ['screen', screenGroup, 3000],
    ['webgl', webglGroup, 15000],
    ['transferredWebgl', transferredWebglGroup, 18000],
    ['webgpu', webgpuGroup, 9000],
    ['canvas2d', canvas2dGroup, 12000],
    ['float16', float16Group, 9000],
    ['audio', audioGroup, 15000],
    ['fonts', fontsGroup, 15000],
    ['webrtc', webrtcGroup, 12000],
    ['network', networkGroup, 10000]
  ];
  return domReady().then(function () {
    var settled = groups.map(function (g) {
      return withTimeout(Promise.resolve().then(g[1]), g[2], g[0]).then(
        function (v) { return [g[0], v]; },
        function (e) { return [g[0], { error: String(e && e.message || e), timeout: /timeout/.test(String(e)) }]; }
      );
    });
    return Promise.all(settled);
  }).then(async function (entries) {
    entries.forEach(function (entry) { report.raw[entry[0]] = entry[1]; });
    report.checks = buildChecks(report);
    renderSection('sec-first', 'out-first', report.raw.firstScript);
    renderSection('sec-contexts', 'out-contexts',
      { availableContexts: report.raw.contexts && report.raw.contexts.availableContexts,
        identityMatrix: report.raw.contexts && report.raw.contexts.identityMatrix,
        contextDetails: report.raw.contexts && report.raw.contexts.contexts });
    renderSection('sec-timezone', 'out-timezone', report.raw.timezone);
    renderSection('sec-screen', 'out-screen', report.raw.screen);
    renderSection('sec-webgl', 'out-webgl', report.raw.webgl);
    renderSection('sec-webgpu', 'out-webgpu', report.raw.webgpu);
    renderSection('sec-canvas2d', 'out-canvas2d', report.raw.canvas2d);
    renderSection('sec-float16', 'out-float16', report.raw.float16);
    renderSection('sec-audio', 'out-audio', report.raw.audio);
    renderSection('sec-fonts', 'out-fonts', report.raw.fonts);
    renderSection('sec-webrtc', 'out-webrtc', report.raw.webrtc);
    renderSection('sec-network', 'out-network', report.raw.network);
    report.cleanup = await withTimeout(cleanup(), 5000, 'cleanup');
    report.checks.push({ id: 'resource-cleanup', passed: report.cleanup.errors.length === 0,
      detail: report.cleanup.errors.join('; ') });
    renderChecks(report.checks);
    var pre = document.getElementById('out-cleanup');
    if (pre) pre.textContent = JSON.stringify(report.cleanup, null, 1);
    report.completedAt = new Date().toISOString();
    return report;
  });
}

window.irisProbe = run().catch(function (err) {
  /* 主流程本身不应 reject；此处兜底保证客户端总能拿到报告对象。 */
  return {
    fixture: 'iris-demo-probe/1',
    fatal: String(err && err.message || err),
    checks: [{ id: 'probe-fatal', passed: false, detail: String(err && err.stack || err) }],
    raw: {}
  };
});
})();
