/* iris-demo worker 测量脚本：同一文件同时服务 dedicated worker 与 shared worker，
   通过 'onconnect' in self 区分执行环境（SharedWorkerGlobalScope 才有 onconnect）。
   本脚本不接触 window/DOM；采样 identity、时区、OffscreenCanvas 输出与 measureText，
   结果带请求 nonce 回传，供父页校验。API 名保持英文。 */
'use strict';

var HIGH_ENTROPY = ['architecture', 'bitness', 'model', 'platformVersion',
                    'uaFullVersion', 'fullVersionList', 'wow64'];
var CANVAS_W = 64, CANVAS_H = 48;

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

function coreSample() {
  var n = navigator;
  return {
    contextKind: null, /* 由调用方填充 */
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

async function highEntropySample() {
  if (!navigator.userAgentData) return { supported: false, error: 'userAgentData 不存在', values: null };
  try {
    var high = await navigator.userAgentData.getHighEntropyValues(HIGH_ENTROPY);
    return { supported: true, error: null, values: JSON.parse(JSON.stringify(high)) };
  } catch (err) {
    return { supported: true, error: String(err && err.message || err), values: null };
  }
}

/* 与主页面 probe.js 的 drawOps 保持逐字节一致的绘制序列（跨上下文一致性对照）。 */
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

function hexOf(buffer) {
  var bytes = new Uint8Array(buffer);
  var out = [];
  for (var i = 0; i < bytes.length; i++) out.push(bytes[i].toString(16).padStart(2, '0'));
  return out.join('');
}

async function sha256Hex(buffer) {
  var digest = await crypto.subtle.digest('SHA-256', buffer);
  return hexOf(digest);
}

async function offscreenCanvasSample() {
  var out = { supported: typeof OffscreenCanvas === 'function' };
  if (!out.supported) return out;
  try {
    var oc = new OffscreenCanvas(CANVAS_W, CANVAS_H);
    var ctx = oc.getContext('2d', { alpha: true });
    if (!ctx) return { supported: true, error: 'getContext("2d") 返回 null' };
    drawOps(ctx);
    var pixels = ctx.getImageData(0, 0, CANVAS_W, CANVAS_H);
    out.attributes = ctx.getContextAttributes ? ctx.getContextAttributes() : null;
    out.width = oc.width;
    out.height = oc.height;
    out.pixelDigest = await sha256Hex(pixels.data.buffer);
    var firstPixel = Array.from(pixels.data.slice(0, 8));
    out.firstPixelBytes = firstPixel;
    var blob = await oc.convertToBlob({ type: 'image/png' });
    var pngBytes = new Uint8Array(await blob.arrayBuffer());
    out.png = {
      type: blob.type,
      length: pngBytes.length,
      magic: hexOf(pngBytes.buffer.slice(0, 8)),
      digest: await sha256Hex(pngBytes)
    };
    /* ImageDecoder+VideoFrame.copyTo 原始解码（SharedWorkerGlobalScope 未暴露
       ImageDecoder，届时如实记录不支持），取得未再经过 canvas 读取的序列化字节。 */
    if (typeof ImageDecoder === 'function' && typeof VideoFrame === 'function') {
      var decoder = null, frame = null;
      try {
        decoder = new ImageDecoder({ data: pngBytes.buffer, type: 'image/png',
                                     colorSpaceConversion: 'none' });
        frame = (await decoder.decode({ frameIndex: 0 })).image;
        var size = frame.allocationSize();
        var raw = new Uint8Array(size);
        await frame.copyTo(raw);
        if (!/^(RGBA|BGRA|RGBX|BGRX)$/.test(frame.format) || size !== pixels.data.length)
          throw new Error('无法逐像素比较 PNG 解码格式或尺寸: ' + frame.format);
        var rgba = frame.format === 'RGBA' ? raw : new Uint8Array(size);
        if (rgba !== raw) {
          var swap = frame.format.startsWith('BGR');
          for (var i = 0; i < size; i += 4) {
            rgba[i] = raw[i + (swap ? 2 : 0)];
            rgba[i + 1] = raw[i + 1];
            rgba[i + 2] = raw[i + (swap ? 0 : 2)];
            rgba[i + 3] = frame.format === 'BGRA' ? raw[i + 3] : 255;
          }
        }
        out.decodedPixelDigest = await sha256Hex(rgba.buffer);
        out.png.rawDecode = { supported: true, format: frame.format, byteLength: size,
                              digest: await sha256Hex(raw.buffer),
                              rgbaDigest: out.decodedPixelDigest };
      } catch (err) {
        out.png.rawDecode = { error: String(err && err.message || err) };
      } finally {
        if (frame) frame.close();
        if (decoder) decoder.close();
      }
    } else {
      out.png.rawDecode = { supported: false,
                            reason: 'ImageDecoder 在此 worker 上下文不可用' };
    }
  } catch (err) {
    out.error = String(err && err.message || err);
  }
  return out;
}

function measureTextSample() {
  var out = { supported: typeof OffscreenCanvas === 'function' };
  if (!out.supported) return out;
  try {
    var ctx = new OffscreenCanvas(8, 8).getContext('2d');
    var text = 'MmWw0IlO.';
    function w(font) { ctx.font = font; return ctx.measureText(text).width; }
    out.widths = {
      'Arial': w('32px Arial'),
      'Times New Roman': w('32px "Times New Roman"'),
      'Consolas': w('32px Consolas'),
      'monospace': w('32px monospace'),
      'missingFamilyFallback': w('32px IrisMissingFontXYZ')
    };
  } catch (err) {
    out.error = String(err && err.message || err);
  }
  return out;
}

async function buildReport(contextKind) {
  var sample = coreSample();
  sample.contextKind = contextKind;
  sample.workerOrigin = self.location && self.location.origin ? self.location.origin : null;
  sample.workerHref = self.location && self.location.href ? self.location.href : null;
  sample.highEntropy = await highEntropySample();
  sample.timezone = timezoneSample();
  sample.offscreenCanvas = await offscreenCanvasSample();
  sample.measureText = measureTextSample();
  return sample;
}

function isRequest(data) {
  return !!data && typeof data === 'object' && data.iris === 'iris-worker-request' &&
         typeof data.nonce === 'string' && data.nonce.length > 0;
}

async function respond(post, data, contextKind) {
  if (!isRequest(data)) {
    post({ iris: 'iris-worker-error', error: '非法请求：需要 {iris:"iris-worker-request", nonce}' });
    return;
  }
  try {
    var report = await buildReport(contextKind);
    post({ iris: 'iris-worker-report', nonce: data.nonce, report: report });
  } catch (err) {
    post({ iris: 'iris-worker-error', nonce: data.nonce, error: String(err && err.message || err) });
  }
}

async function transferredWebgl(data) {
  var gl = null;
  try {
    var canvas = data.canvas;
    gl = canvas.getContext(data.kind, {
      alpha: true, premultipliedAlpha: false, antialias: false, preserveDrawingBuffer: true
    });
    if (!gl) throw new Error('转移画布无法创建 ' + data.kind);
    var is2 = data.kind === 'webgl2';
    var sources = is2 ? [
      '#version 300 es\nin vec2 position;void main(){gl_Position=vec4(position,0,1);}',
      '#version 300 es\nprecision highp float;out vec4 color;void main(){color=vec4(64.,128.,192.,128.)/255.;}'
    ] : [
      'attribute vec2 position;void main(){gl_Position=vec4(position,0,1);}',
      'precision highp float;void main(){gl_FragColor=vec4(64.,128.,192.,128.)/255.;}'
    ];
    var program = gl.createProgram();
    sources.forEach(function (source, i) {
      var shader = gl.createShader(i ? gl.FRAGMENT_SHADER : gl.VERTEX_SHADER);
      gl.shaderSource(shader, source); gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
      gl.attachShader(program, shader); gl.deleteShader(shader);
    });
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    gl.useProgram(program);
    var buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    var position = gl.getAttribLocation(program, 'position');
    gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    await new Promise(function (resolve) {
      requestAnimationFrame(function () {
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        requestAnimationFrame(resolve);
      });
    });
    var pixels = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    var error = gl.getError();
    var blob = await canvas.convertToBlob({ type: 'image/png' });
    var png = await blob.arrayBuffer();
    self.postMessage({ iris: 'iris-transfer-report', kind: data.kind,
      width: canvas.width, height: canvas.height, attributes: gl.getContextAttributes(),
      pixels: pixels, png: png, error: error }, [pixels.buffer, png]);
  } catch (err) {
    self.postMessage({ iris: 'iris-transfer-report', kind: data.kind, error: String(err) });
  }
}

if ('onconnect' in self) {
  /* SharedWorkerGlobalScope：每个连接一个 MessagePort。 */
  self.onconnect = function (event) {
    var port = event.ports[0];
    port.onmessage = function (e) {
      respond(function (msg) { port.postMessage(msg); }, e.data, 'shared-worker');
    };
    port.start();
  };
} else {
  /* DedicatedWorkerGlobalScope */
  self.onmessage = function (e) {
    if (e.data && e.data.iris === 'iris-transfer-webgl') {
      transferredWebgl(e.data);
      return;
    }
    respond(function (msg) { self.postMessage(msg); }, e.data, 'dedicated-worker');
  };
}
