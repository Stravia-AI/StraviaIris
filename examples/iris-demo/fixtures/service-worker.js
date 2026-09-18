/* iris-demo service worker 测量脚本：仅响应带 nonce 的取样请求并回报 ServiceWorker
   全局作用域内实际支持的身份/时区 API。本脚本：
   - 不注册 fetch 事件处理器（避免影响 /submit、/complete 等真实请求）；
   - 不调用 skipWaiting / clients.claim（不抢占页面控制权）；
   - 不引用 window/document（SW 作用域不存在这些全局）。API 名保持英文。 */
'use strict';

var HIGH_ENTROPY = ['architecture', 'bitness', 'model', 'platformVersion',
                    'uaFullVersion', 'fullVersionList', 'wow64'];

self.addEventListener('install', function () { /* 立即进入 waiting，无额外逻辑 */ });
self.addEventListener('activate', function () { /* 保持默认激活流程 */ });

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

async function buildReport() {
  var n = navigator;
  var sample = {
    contextKind: 'service-worker',
    scriptURL: self.registration ? self.registration.active && self.registration.active.scriptURL : null,
    scope: self.registration ? self.registration.scope : null,
    state: self.registration && self.registration.active ? 'active' : null,
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
    } : null,
    timezone: timezoneSample(),
    highEntropy: { supported: false, error: 'userAgentData 不存在', values: null }
  };
  if (n.userAgentData) {
    try {
      var high = await n.userAgentData.getHighEntropyValues(HIGH_ENTROPY);
      sample.highEntropy = { supported: true, error: null, values: JSON.parse(JSON.stringify(high)) };
    } catch (err) {
      sample.highEntropy = { supported: true, error: String(err && err.message || err), values: null };
    }
  }
  return sample;
}

self.addEventListener('message', function (event) {
  var data = event.data;
  if (!data || typeof data !== 'object' || data.iris !== 'iris-sw-request' ||
      typeof data.nonce !== 'string' || data.nonce.length === 0) {
    if (event.source && event.source.postMessage) {
      event.source.postMessage({ iris: 'iris-sw-error',
                                 error: '非法请求：需要 {iris:"iris-sw-request", nonce}' });
    }
    return;
  }
  buildReport().then(function (report) {
    event.source.postMessage({ iris: 'iris-sw-report', nonce: data.nonce, report: report });
  }, function (err) {
    event.source.postMessage({ iris: 'iris-sw-error', nonce: data.nonce,
                               error: String(err && err.message || err) });
  });
});
