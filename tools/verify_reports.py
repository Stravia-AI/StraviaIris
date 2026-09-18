"""对四个真实运行报告进行独立契约校验；不读取 checks 的通过状态。"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import math
from pathlib import Path
import re
import struct
import sys
import zlib

ROOT = Path(__file__).resolve().parents[1]
MASK = (1 << 64) - 1
CONTEXTS = {'window', 'sameOriginIframe', 'crossSiteIframe', 'dedicatedWorker', 'sharedWorker', 'serviceWorker'}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def load(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def sha(data):
    return hashlib.sha256(data).hexdigest()


def mix(value):
    value = ((value ^ (value >> 30)) * 0xbf58476d1ce4e5b9) & MASK
    value = ((value ^ (value >> 27)) * 0x94d049bb133111eb) & MASK
    return value ^ (value >> 31)


def rotate(value, amount):
    return ((value << amount) | (value >> (64 - amount))) & MASK


def noise(seed, domain, x, y, channel, bits):
    return (bits & ~1) | (mix(seed ^ domain ^ mix(x) ^ rotate(mix(y), 17) ^ rotate(mix(channel), 33) ^ mix(bits & ~1)) & 1)


def png(data, decode=False):
    require(data[:8] == b'\x89PNG\r\n\x1a\n', 'PNG signature 不符')
    offset, compressed, header, ended = 8, bytearray(), None, False
    while offset < len(data):
        require(offset + 12 <= len(data), 'PNG chunk 截断')
        length = int.from_bytes(data[offset:offset + 4], 'big')
        kind = data[offset + 4:offset + 8]
        payload = data[offset + 8:offset + 8 + length]
        require(offset + 12 + length <= len(data), 'PNG chunk 长度越界')
        crc = int.from_bytes(data[offset + 8 + length:offset + 12 + length], 'big')
        require(zlib.crc32(kind + payload) & 0xffffffff == crc, 'PNG CRC 不符')
        if kind == b'IHDR':
            require(header is None and length == 13, 'PNG IHDR 不合法')
            header = struct.unpack('>IIBBBBB', payload)
        elif kind == b'IDAT':
            compressed.extend(payload)
        elif kind == b'IEND':
            ended = True
        offset += length + 12
    require(header and ended, 'PNG 缺少 IHDR/IEND')
    if not decode:
        return header[:2]
    width, height, depth, color, compression, filtering, interlace = header
    require((depth, color, compression, filtering, interlace) == (16, 6, 0, 0, 0), 'float16 导出必须是非交错 RGBA PNG16')
    require(width * height <= 1024, 'float16 探针尺寸异常')
    stride, bpp = width * 8, 8
    raw = zlib.decompress(compressed)
    require(len(raw) == (stride + 1) * height, 'PNG scanline 长度不符')
    previous, decoded = bytearray(stride), bytearray()
    for y in range(height):
        start = y * (stride + 1)
        filter_type = raw[start]
        require(filter_type <= 4, 'PNG filter 不合法')
        row = bytearray(raw[start + 1:start + 1 + stride])
        for x in range(stride):
            left = row[x - bpp] if x >= bpp else 0
            up = previous[x]
            upper_left = previous[x - bpp] if x >= bpp else 0
            p = left + up - upper_left
            distances = [abs(p - left), abs(p - up), abs(p - upper_left)]
            paeth = [left, up, upper_left][distances.index(min(distances))]
            predictors = [0, left, up, (left + up) // 2, paeth]
            row[x] = (row[x] + predictors[filter_type]) & 255
        decoded.extend(row)
        previous = row
    return width, height, list(struct.unpack('>' + 'H' * (len(decoded) // 2), decoded))


def digest(value, label):
    require(isinstance(value, str) and re.fullmatch('[a-f0-9]{64}', value), f'{label}: 非 SHA-256')
    return value


def brands(header):
    parts = re.findall(r'("(?:[^"\\]|\\.)*")\s*;\s*v=("(?:[^"\\]|\\.)*")', header)
    require(parts, 'UA-CH brands 格式非法')
    return sorted((json.loads(brand), json.loads(version)) for brand, version in parts)


def timezone(sample):
    require(sample['resolvedTimeZone'] == 'Europe/Berlin', '时区不符')
    require((sample['offsetWinterMinutes'], sample['offsetSummerMinutes']) == (-60, -120), '冬夏 DST 偏移不符')


def verify(path, report, profile, lock, manifest, host_fonts):
    raw, sdk = report['raw'], report['irisSdk']
    seed = sdk['seed']
    version = lock['chromium']['tag'].removeprefix('refs/tags/')
    require(sdk['bindingBuildId'] == manifest['engine_build_id'], '运行引擎 build ID 与分发清单不符')
    require(sdk['browserVersion']['product'] == 'Chrome/' + version, '实际 Browser.getVersion 不符')
    require(sdk['browserVersion']['revision'] == '@' + lock['chromium']['commit'], '实际 Chromium revision 不符')
    require(manifest['identity']['cef'] == lock['cef']['commit'] and manifest['identity']['chromium'] == lock['chromium']['commit'], '清单未绑定锁定 revision')
    contexts = raw['contexts']['contexts']
    require(set(contexts) == CONTEXTS, '缺少规定上下文')
    window = contexts['window']
    identity = {key: window[key] for key in ('userAgent', 'appVersion', 'platform', 'language', 'languages', 'hardwareConcurrency', 'deviceMemory', 'userAgentData', 'highEntropy')}
    ua = window['userAgent']
    require('HeadlessChrome' not in ua and f'Chrome/{version.split(".")[0]}.0.0.0 ' in ua, 'UA 缩减版本或 Headless 身份错误')
    for name, entry in contexts.items():
        sample = entry if name == 'window' else entry['sample' if name.endswith('Iframe') else 'report']
        require({key: sample[key] for key in identity} == identity, f'{name}: 跨上下文身份不一致')
        require(sample['platform'] == profile['platform'] and sample['languages'] == profile['languages'], f'{name}: 平台/语言不符')
        require(sample['language'] == profile['languages'][0], f'{name}: 主语言不符')
        require(sample['hardwareConcurrency'] == profile['hardware_concurrency'] and sample['deviceMemory'] == profile['device_memory'], f'{name}: 硬件字段不符')
        worker = name.endswith('Worker')
        require(sample['webdriver'] == {'present': not worker, 'typeofValue': 'undefined' if worker else 'boolean',
                                       'value': None if worker else False}, f'{name}: webdriver 暴露契约错误')
        require(sample['maxTouchPoints'] == (None if name.endswith('Worker') else profile['max_touch_points']), f'{name}: touch API 语义错误')
        he = sample['highEntropy']['values']
        for key, expected in {'architecture': 'x86', 'bitness': '64', 'platform': 'Windows', 'platformVersion': profile['user_agent']['platform_version'], 'mobile': False, 'wow64': False, 'model': '', 'uaFullVersion': version}.items():
            require(he[key] == expected, f'{name}: UA-CH {key} 不符')
        for brand in ('Chromium', 'Google Chrome'):
            require(any(b['brand'] == brand and b['version'] == version for b in he['fullVersionList']), f'{name}: 缺少绑定真实版本的 {brand} brand')
        timezone(sample['timezone'])
        if name.endswith('Iframe'):
            require(all(entry['validation'][key] is True for key in ('sourceMatches', 'originMatches', 'tokenMatches')), f'{name}: 消息来源未验证')
            require(not entry['wildcardTargetOrigin'], f'{name}: 使用通配目标源')
    first = raw['firstScript']
    for key in ('userAgent', 'platform', 'languages', 'hardwareConcurrency', 'deviceMemory'):
        require(first['navigator'][key] == window[key], f'首脚本 {key} 与稳定状态不一致')
    require(first['webdriver']['inNavigator'] is True and first['webdriver']['descriptorOnNavigatorPrototype'] is True
            and first['webdriver']['value'] is False, '首脚本 webdriver 契约不符')
    for key, desc in first['descriptors'].items():
        require(desc['hasGetter'] and '[native code]' in desc['getterSource'], f'{key}: 非原生 getter')
    for key, function in first['nativeFunctionSources'].items():
        require('[native code]' in function['source'], f'{key}: 非原生函数')
    low_brands = sorted(map(tuple, window['userAgentData']['brands']))
    full_brands = sorted((b['brand'], b['version']) for b in window['highEntropy']['values']['fullVersionList'])
    requests = [first['navigationRequest']['headers']]
    for name in ('echoBeforeAcceptCh', 'acceptCh', 'echoAfterAcceptCh', 'redirect'):
        response = raw['network'][name]
        require(response['status'] == 200, f'{name}: HTTP 请求失败')
        headers = response['body']['headers']
        requests.append(headers)
        require(brands(headers['sec-ch-ua-full-version-list']) == full_brands, f'{name}: full brands 不一致')
        for key, expected in {'arch': 'x86', 'bitness': '64', 'platform-version': profile['user_agent']['platform_version'], 'full-version': version, 'model': ''}.items():
            require(json.loads(headers['sec-ch-ua-' + key]) == expected, f'{name}: header {key} 不符')
        require(headers['sec-ch-ua-wow64'] == '?0' and headers['device-memory'] == '8', f'{name}: wow64/device memory 不符')
    for headers in requests:
        require(headers['user-agent'] == ua and headers['accept-language'] == 'en-US,en;q=0.9', '网络 UA/语言不一致')
        require(brands(headers['sec-ch-ua']) == low_brands and json.loads(headers['sec-ch-ua-platform']) == 'Windows' and headers['sec-ch-ua-mobile'] == '?0', '低熵 UA-CH 不一致')
    require(raw['network']['redirect']['redirected'] and raw['network']['redirect']['body']['path'] == '/echo?redirected=1', '未完成真实重定向')
    canvas = raw['canvas2d']
    require(canvas['geometry']['semiTransparentPixels'] == 100, 'Canvas 半透明输入未实际覆盖')
    canvas_hash = digest(canvas['geometry']['fullDigest'], 'canvas')
    for export in ('toDataURL', 'toBlob'):
        require(canvas[export]['rawDecode']['rgbaDigest'] == canvas_hash, f'{export}: PNG 与直接读回不同')
    offscreen_hash = digest(canvas['offscreen']['pixelDigest'], 'offscreen')
    require(canvas['offscreen']['decodedPixelDigest'] == offscreen_hash, 'OffscreenCanvas PNG 不同')
    for name in ('dedicatedWorker', 'sharedWorker'):
        image = contexts[name]['report']['offscreenCanvas']
        require(image['pixelDigest'] == offscreen_hash and image['png']['digest'] == canvas['offscreen']['png']['digest'], f'{name}: OffscreenCanvas 像素或 PNG 字节不同')
        if image['png']['rawDecode']['supported']:
            require(image['decodedPixelDigest'] == offscreen_hash, f'{name}: PNG 解码不同')
    for flag in ('cropMatchesFull', 'repeatIdentical'):
        require(canvas['geometry'][flag], f'canvas {flag} 失败')
    require(canvas['errors']['zeroSizeToDataURL']['value'] == 'data:,', '空画布序列化错误')
    require(canvas['errors']['emptySizeGetImageData']['name'] == 'IndexSizeError', '空读出错误类型变化')
    for item in canvas['errors']['taint'].values():
        require(item['threw'] and item['name'] == 'SecurityError', 'taint 没有保持 SecurityError')
    floating = raw['float16']
    bits = [int(value, 16) for value in floating['baselinePixel']['directBits']]
    expected_bits = [noise(seed, 0x4952495343414e56, 0, 0, ch, value) if ch < 3 else value for ch, value in enumerate((0x0401, 0x1001, 0x3001, 0x3c00))]
    require(bits == expected_bits, 'float16 原生 mantissa 位与固定算法不符')
    require(floating['regionPixel']['regionBits'] == floating['regionPixel']['fullBits'][4:], 'float16 裁剪坐标不一致')
    encoded = base64.b64decode(floating['png']['bytesBase64'], validate=True)
    require(sha(encoded) == floating['png']['digest'], 'float16 PNG 摘要不符')
    width, height, samples = png(encoded, True)
    expected_png = [math.floor(struct.unpack('<e', struct.pack('<H', bit))[0] * 65535 + 0.5) for bit in bits]
    require((width, height) == (1, 1) and samples == expected_png, f'float16 → PNG16 原生量化不符: {samples} != {expected_png}')
    gl = raw['webgl']
    for kind in ('webgl1', 'webgl2'):
        require(gl[kind]['supported'], f'{kind}: 未创建真实上下文')
        require(gl[kind]['unmaskedVendor'] == profile['webgl']['vendor'] and gl[kind]['unmaskedRenderer'] == profile['webgl']['renderer'], f'{kind}: 公开身份不符')
    readback = gl['readback']
    for flag in ('cropMatchesFull', 'repeatIdentical', 'pboMatchesTyped', 'pboOffsetMatchesTyped'):
        require(readback[flag], f'WebGL {flag} 失败')
    require(readback['serialization']['rawDecode']['rgbaDigest'] == readback['serialization']['snapshotDigest'], 'WebGL PNG domain/坐标不一致')
    require(readback['basicError']['count'] == 0 and readback['rgbaPacking']['error']['count'] == 0 and readback['rgbaPacking']['matches'] and readback['rgbaPacking']['paddingIntact'], 'WebGL 合法 packing/offset 失败')
    rgb = readback['rgbPacking']
    if rgb['supported']:
        require(rgb['align1EqualsAlign4'] and rgb['rgbMatchesRgbaChannels'], 'RGB packing 不符')
    else:
        require(rgb['rejectedWithoutMutation'] and rgb['align1Error']['last'] == rgb['align4Error']['last'] == 0x502, '不支持的 RGB 未保持原生拒绝且不写目标')
    require(readback['float']['samplesCompared'] == 256 and readback['float']['pboTypedMismatch'] == 0 and readback['float']['typedError']['count'] == readback['float']['pboError']['count'] == 0, 'FLOAT PBO 不一致')
    for kind in ('webgl', 'webgl2'):
        transfer = raw['transferredWebgl'][kind]
        expected = []
        for y in reversed(range(8)):
            for x in range(8):
                expected.extend([noise(seed, 0x4952495357454247, x, y, ch, value) for ch, value in enumerate((64, 128, 192))] + [128])
        require(transfer['pixels'] == transfer['placeholderPixels'] == expected, f'{kind}: worker/placeholder 半透明像素与固定算法不同')
        require(transfer['workerPng']['hardMismatches'] == 0, f'{kind}: worker PNG 不同')
    audio = raw['audio']
    rendered = audio['render']
    rate = profile['audio_sample_rate']
    require((rendered['length'], rendered['sampleRate'], rendered['duration']) == (44100, rate, 44100 / rate), 'OfflineAudioContext 未使用真实 profile 采样率')
    audio_hash = digest(rendered['channelDataDigest'], 'offline audio')
    require(audio_hash == 'a82ddb7c4175f2c2669dd5fdbfcc1eab93b82f9dc672bd0a4b4fc84e61bda707', '离线波形偏离已验证的原生 48 kHz 渲染')
    require(audio_hash == rendered['repeatGetChannelDataDigest'] == rendered['secondContextDigest'], '离线音频重复读出或第二上下文不一致')
    require(rendered['sampleBits'] == rendered['copyBits'], 'copyFromChannel 位模式不同')
    require(audio['live']['defaultSampleRate'] == rate and audio['live']['explicitSampleRate']['actual'] == rate, '实时音频采样率契约不同')
    require(all(audio['invalidSampleRate'][kind] == {'accepted': False, 'error': 'NotSupportedError'} for kind in ('live', 'offline')), 'profile 采样率覆盖吞掉了非法输入')
    require(audio['live']['bufferWrite']['readBits'] == audio['live']['bufferWrite']['writtenBits'], 'AudioBuffer 用户写入被扰动')
    font = raw['fonts']
    for family in profile['fonts']:
        local = font['families'][family]['localLoad']
        expected_local = family not in {'Franklin Gothic', 'Yu Gothic'}
        require(local['loaded'] == expected_local and (expected_local or local['error'] == 'NetworkError'), f'{family}: 字体家族和 local 唯一名称边界不同')
    require({entry['family'] for entry in font['localFontAccess']['entries']} == set(profile['fonts']), 'FontAccess 枚举泄漏或缺失')
    require(len(font['localFontAccess']['entries']) == len(profile['fonts']) and all(entry['postscriptName'] == entry['family'].replace(' ', '') and entry['style'] == 'Regular' for entry in font['localFontAccess']['entries']), 'FontAccess 枚举身份不符')
    for family, measurement in font['disallowedCandidates'].items():
        require(family in host_fonts, f'缺少 {family} 确实已安装的主机证据')
        require(measurement['localLoad']['loaded'] is False and measurement['localLoad']['error'] == 'NetworkError' and measurement['width'] == font['missingFallbackWidth'], f'{family}: 本地字体选择绕过限制')
    # DOM LayoutUnit 按 1/64px 量化；Canvas 保留浮点前进宽度。
    for key, family in {'arial': 'Arial', 'verdana': 'Verdana', 'georgia': 'Georgia', 'georgiaWithFallback': 'Georgia', 'fantasy': 'Impact', 'serifWithFallback': 'Verdana'}.items():
        require(abs(font['cssSpan'][key] - font['families'][family]['width']) <= 1 / 64, f'CSS {key} 字体选择不同')
    require(all(font['cssSpan'][key] == font['cssSpan']['arial'] for key in ('serif', 'sansSerif', 'monospace', 'cursive', 'missing')), 'DOM 泛型或缺失字体未使用原生最终回退')
    for generic, field in {'serif': 'serif', 'sans-serif': 'sans_serif', 'monospace': 'monospace', 'cursive': 'cursive', 'fantasy': 'fantasy', 'math': 'math'}.items():
        require(font['genericFamilies'][generic] == font['families'][profile['generic_fonts'][field]]['width'], f'Canvas {generic} 泛型解析不同')
    require(font['missingFallbackWidth'] == font['families'][profile['generic_fonts']['standard']]['width'], 'Canvas 标准回退不同')
    require(font['webFont']['widthAfterLoad'] == 400 and font['webFont']['widthBeforeLoad'] != 400, '网络 Ahem 字体未实际生效')
    screen = raw['screen']
    for key, field in {'width': 'width', 'height': 'height', 'availWidth': 'available_width', 'availHeight': 'available_height', 'devicePixelRatio': 'device_scale_factor', 'colorDepth': 'color_depth', 'pixelDepth': 'pixel_depth'}.items():
        require(screen[key] == profile['screen'][field], f'screen.{key} 不符')
    require(screen['orientation']['type'] == 'landscape-primary' and screen['matchMedia']['resolution']['matches'], '屏幕方向或 DPR media query 不一致')
    for key, field in {'innerWidth': 'inner_width', 'innerHeight': 'inner_height', 'outerWidth': 'outer_width', 'outerHeight': 'outer_height'}.items():
        require(screen['viewport'][key] == profile['screen'][field], f'viewport.{key} 不符')
    require(screen['visualViewport']['width'] == profile['screen']['inner_width'] and screen['visualViewport']['height'] == profile['screen']['inner_height'], 'visualViewport 申报尺寸不符')
    require(screen['matchMedia']['color8Bit'] == (profile['screen']['depth_per_component'] == 8) and screen['matchMedia']['color10Bit'] == (profile['screen']['depth_per_component'] == 10), 'CSS RGB 分量位深不符')
    screenshot_size = png(path.with_name('screenshot.png').read_bytes())
    require(screenshot_size == (profile['screen']['viewport_width'], profile['screen']['viewport_height']), '截图与实际渲染尺寸不符')
    timezone(raw['timezone'])
    rtc = raw['webrtc']
    require(rtc['closed'] and rtc['gathering']['finalState'] == 'complete', 'ICE 未完整执行并关闭')
    require(rtc['gathering']['candidates'] == [] and rtc['configuredServers'] == [], '无代理本地 ICE 出现不应存在的候选')
    gpu = raw['webgpu']
    if gpu['supported']:
        require(all(gpu['adapterInfo'][key] == profile['webgpu'][key] for key in ('vendor', 'architecture', 'device', 'description')), 'WebGPU 公开身份不符')
        require(set(gpu['features']) == set(profile['webgpu']['features']), 'WebGPU 原生支持特性集合不符')
        require(gpu['render']['rgba'] == [51, 102, 153, 255] * 64, 'WebGPU 实际 WGSL 渲染错误')
    else:
        require(gpu.get('unavailable') in ('api-unavailable', 'adapter-unavailable') and not gpu.get('error'), 'WebGPU 运行错误不可当作不支持')
    require(report['cleanup']['errors'] == [] and report['cleanup']['serviceWorkerUnregister']['result'], '资源清理错误')
    require(sdk['submission'] == {'method': 'POST', 'value': 'StraviaIris'} and sdk['finalNavigation']['complete'], '表单或最终导航未完成')
    return {'identity': identity, 'digests': {'canvas': canvas_hash, 'offscreen': offscreen_hash, 'audio': audio_hash, 'webgl': digest(readback['fullDigest'], 'WebGL')}, 'screenshot': screenshot_size, 'png16': samples}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('reports', nargs=4, type=Path)
    parser.add_argument('--manifest', type=Path)
    parser.add_argument('--font-inventory', type=Path, default=ROOT / 'out/verification/system-font-families.json')
    args = parser.parse_args()
    manifest_path = args.manifest or next((p for p in (ROOT / 'engine-distribution.json', ROOT / 'out/cef/iris-distribution.json') if p.is_file()), None)
    require(manifest_path, '找不到实际引擎清单；使用 --manifest')
    profile, lock, manifest = load(ROOT / 'profiles/windows-desktop.json'), load(ROOT / 'engine.lock.json'), load(manifest_path)
    reports = [load(path) for path in args.reports]
    require([r['irisSdk']['seed'] for r in reports] == [42, 42, 43, 42], '四次运行 seed 顺序必须为 42/42/43/42')
    require([r['irisSdk']['windowMode'] for r in reports] == ['headless'] * 3 + ['windowed'], '四次运行模式不符')
    host_fonts = set(load(args.font_inventory)['families'])
    results = [verify(path, report, profile, lock, manifest, host_fonts) for path, report in zip(args.reports, reports)]
    require(all(result['identity'] == results[0]['identity'] for result in results[1:]), '跨 seed/窗口模式身份变化')
    require(results[0]['digests'] == results[1]['digests'] == results[3]['digests'], '相同 seed 跨 fresh-cache/窗口模式摘要不同')
    require(results[0]['digests']['audio'] == results[2]['digests']['audio'], '原生音频波形不应随 seed 改变')
    require(all(results[0]['digests'][key] != results[2]['digests'][key] for key in ('canvas', 'offscreen', 'webgl')), '不同 seed 未改变固定 canvas/offscreen/WebGL 用例')
    print(json.dumps({'verified': [str(path) for path in args.reports], 'engine_build_id': manifest['engine_build_id'], 'results': results}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError, struct.error, zlib.error) as error:
        print(f'报告验收失败：{error}', file=sys.stderr)
        sys.exit(1)
