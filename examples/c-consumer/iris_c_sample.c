// StraviaIris C 接入样例：客户端 DLL，由 bootstrapc.exe --module=iris_c_sample
// 加载并经标准 RunConsoleMain 入口启动。
//
// 演示内容：
//   1. 标准入口转发——RunConsoleMain 只把 bootstrap 提供的 sandbox/version
//      指针转交 iris_bootstrap_main（本文件不触碰 CEF 头文件与 unsafe 细节，
//      version_info 按不透明指针转发）；
//   2. 事件回调驱动的完整生命周期——Ready 创建 browser、Page.enable →
//      Page.navigate → 关闭 browser、BrowserClosed 后请求 shutdown；
//   3. 参数处理剔除 bootstrap 消费的 --module。
//
// 参数：--url=<URL> --seed=<decimal> --headless|--windowed
//       [--cache-dir=<绝对路径>] [--timezone=<IANA>] [--cdp-port=<1..65535>]
// 缺省：windowed、host 时区、CDP 关闭、cache 目录默认 %TEMP%\iris-c-sample。

#include <stravia_iris.h>

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <windows.h>

// ---------------------------------------------------------------------------
// 参数（bootstrap 主线程在回调外解析一次）
// ---------------------------------------------------------------------------

typedef struct SampleOptions {
  const char* url;
  unsigned long long seed;
  int windowless;
  const char* cache_dir;
  const char* timezone;
  unsigned long cdp_port;
} SampleOptions;

static SampleOptions g_options;
typedef struct SampleArguments {
  int argc;
  char** argv;
} SampleArguments;

// bootstrap 消费的 --module=<name> 不属于样例参数，直接跳过。
static int IsBootstrapSwitch(const char* arg) {
  return strncmp(arg, "--module=", 9) == 0;
}

static int ParseOptions(int argc, char** argv, char* error, size_t error_size) {
  g_options.url = "https://example.invalid/";
  g_options.seed = 42;
  g_options.windowless = 0;
  g_options.cache_dir = NULL;
  g_options.timezone = NULL;
  g_options.cdp_port = 0;

  for (int i = 1; i < argc; ++i) {
    const char* arg = argv[i];
    if (IsBootstrapSwitch(arg)) {
      continue;
    }
    if (strncmp(arg, "--url=", 6) == 0) {
      g_options.url = arg + 6;
    } else if (strncmp(arg, "--seed=", 7) == 0) {
      const char* value = arg + 7;
      char* end = NULL;
      errno = 0;
      g_options.seed = strtoull(value, &end, 10);
      if (*value < '0' || *value > '9' || end == value || *end != '\0' || errno == ERANGE) {
        _snprintf(error, error_size, "illegal seed: %s", value);
        return 0;
      }
    } else if (strcmp(arg, "--headless") == 0) {
      g_options.windowless = 1;
    } else if (strcmp(arg, "--windowed") == 0) {
      g_options.windowless = 0;
    } else if (strncmp(arg, "--cache-dir=", 12) == 0) {
      g_options.cache_dir = arg + 12;
    } else if (strncmp(arg, "--timezone=", 11) == 0) {
      g_options.timezone = arg + 11;
    } else if (strncmp(arg, "--cdp-port=", 11) == 0) {
      const char* value = arg + 11;
      char* end = NULL;
      g_options.cdp_port = strtoul(value, &end, 10);
      if (*value < '0' || *value > '9' || end == value || *end != '\0' ||
          g_options.cdp_port == 0 || g_options.cdp_port > 65535) {
        _snprintf(error, error_size, "illegal cdp-port: %s", value);
        return 0;
      }
    } else {
      _snprintf(error, error_size, "unknown argument: %s", arg);
      return 0;
    }
  }
  return 1;
}

// UTF-8 → UTF-16（cache 路径按原生 UTF-16 传入，不做有损转换）。
static uint16_t* DuplicateUtf8AsUtf16(const char* text, size_t* out_len) {
  int wide_length = MultiByteToWideChar(CP_UTF8, 0, text, -1, NULL, 0);
  if (wide_length <= 0) {
    return NULL;
  }
  wchar_t* wide = (wchar_t*)malloc(sizeof(wchar_t) * (size_t)wide_length);
  if (!wide) {
    return NULL;
  }
  MultiByteToWideChar(CP_UTF8, 0, text, -1, wide, wide_length);
  // len 不含结尾 NUL：SDK 视图按显式长度读取。
  uint16_t* units = (uint16_t*)malloc(sizeof(uint16_t) * (size_t)wide_length);
  if (!units) {
    free(wide);
    return NULL;
  }
  for (int i = 0; i < wide_length; ++i) {
    units[i] = (uint16_t)wide[i];
  }
  free(wide);
  if (out_len) {
    *out_len = (size_t)(wide_length - 1);
  }
  return units;
}

// 组装 Page.navigate 的 params JSON：仅转义反斜杠、引号与控制字符。
static char* BuildNavigateParams(const char* url) {
  size_t capacity = strlen(url) * 6 + 32;
  char* json = (char*)malloc(capacity);
  if (!json) {
    return NULL;
  }
  char* out = json;
  *out++ = '{';
  *out++ = '"';
  *out++ = 'u';
  *out++ = 'r';
  *out++ = 'l';
  *out++ = '"';
  *out++ = ':';
  *out++ = '"';
  for (const char* p = url; *p != '\0'; ++p) {
    unsigned char c = (unsigned char)*p;
    if (c == '"' || c == '\\') {
      *out++ = '\\';
      *out++ = (char)c;
    } else if (c < 0x20) {
      out += _snprintf(out, 7, "\\u%04x", (unsigned)c);
    } else {
      *out++ = (char)c;
    }
  }
  *out++ = '"';
  *out++ = '}';
  *out = '\0';
  return json;
}

// ---------------------------------------------------------------------------
// 事件回调（SDK 在 UI 线程串行调用；所有会话操作在此进行）
// ---------------------------------------------------------------------------

static const char* EventName(uint32_t kind) {
  switch (kind) {
    case IRIS_EVENT_READY:
      return "Ready";
    case IRIS_EVENT_BROWSER_CREATED:
      return "BrowserCreated";
    case IRIS_EVENT_BROWSER_CLOSED:
      return "BrowserClosed";
    case IRIS_EVENT_COMMAND_RESULT:
      return "CommandResult";
    case IRIS_EVENT_PROTOCOL_EVENT:
      return "ProtocolEvent";
    case IRIS_EVENT_LOAD_ERROR:
      return "LoadError";
    case IRIS_EVENT_RENDERER_TERMINATED:
      return "RendererTerminated";
    default:
      return "Unknown";
  }
}

static void PrintEvent(const iris_event_t* event) {
  printf("[iris] %s browser=%llu request=%llu status=%d/%d payload=",
         EventName(event->kind),
         (unsigned long long)event->browser,
         (unsigned long long)event->request,
         event->status.code,
         event->status.native_code);
  if (event->payload_json.len) {
    fwrite(event->payload_json.data, 1, event->payload_json.len, stdout);
  }
  putchar('\n');
  fflush(stdout);
}

// 样例流程状态：Page.enable 完成后导航，导航完成后关闭 browser。
static iris_browser_id_t g_browser = 0;
static int g_page_enabled = 0;
static int g_navigated = 0;
static int g_failed = 0;

static uint32_t OnEvent(iris_session_t* session,
                        const iris_event_t* event,
                        void* user_data) {
  iris_request_id_t request = 0;
  iris_status_t status;

  (void)user_data;
  PrintEvent(event);

  switch (event->kind) {
    case IRIS_EVENT_READY: {
      status = iris_create_browser(session,
                                   (iris_utf8_t){(const uint8_t*)g_options.url,
                                                 strlen(g_options.url)},
                                   &g_browser);
      if (status.code != IRIS_OK) {
        g_failed = 1;
        printf("[sample] create browser failed: %d/%d\n", status.code,
               status.native_code);
        return IRIS_CALLBACK_SHUTDOWN;
      }
      printf("[sample] browser pending id=%llu\n",
             (unsigned long long)g_browser);
      break;
    }
    case IRIS_EVENT_BROWSER_CREATED: {
      status = iris_command(
          session, event->browser,
          (iris_utf8_t){(const uint8_t*)"Page.enable", strlen("Page.enable")},
          (iris_utf8_t){(const uint8_t*)"{}", 2}, &request);
      if (status.code != IRIS_OK) {
        g_failed = 1;
        printf("[sample] Page.enable failed: %d/%d\n", status.code,
               status.native_code);
        iris_close_browser(session, event->browser);
      }
      break;
    }
    case IRIS_EVENT_COMMAND_RESULT: {
      if (event->status.code != IRIS_OK) {
        g_failed = 1;
        iris_close_browser(session, event->browser);
        break;
      }
      if (!g_page_enabled && event->browser == g_browser) {
        g_page_enabled = 1;
        char* params = BuildNavigateParams(g_options.url);
        if (!params) {
          g_failed = 1;
          iris_close_browser(session, event->browser);
          break;
        }
        status = iris_command(
            session, event->browser,
            (iris_utf8_t){(const uint8_t*)"Page.navigate",
                          strlen("Page.navigate")},
            (iris_utf8_t){(const uint8_t*)params, strlen(params)}, &request);
        free(params);
        if (status.code != IRIS_OK) {
          g_failed = 1;
          printf("[sample] Page.navigate submit failed: %d/%d\n", status.code,
                 status.native_code);
          iris_close_browser(session, event->browser);
        }
      } else if (g_page_enabled && !g_navigated && event->browser == g_browser) {
        g_navigated = 1;
        // 导航命令结果只表示 CDP 响应；样例到此即关闭。
        iris_close_browser(session, event->browser);
      }
      break;
    }
    case IRIS_EVENT_LOAD_ERROR: {
      if (event->status.code == IRIS_INITIALIZATION_FAILED) {
        g_failed = 1;
        // 创建失败的 Pending ID 通知：直接结束运行。
        printf("[sample] browser creation failed\n");
        return IRIS_CALLBACK_SHUTDOWN;
      }
      break;
    }
    case IRIS_EVENT_RENDERER_TERMINATED: {
      g_failed = 1;
      printf("[sample] renderer terminated, closing browser\n");
      iris_close_browser(session, event->browser);
      break;
    }
    case IRIS_EVENT_BROWSER_CLOSED: {
      printf("[sample] browser %llu closed; shutting down\n",
             (unsigned long long)event->browser);
      iris_request_shutdown(session);
      break;
    }
    default:
      break;
  }
  return IRIS_CALLBACK_CONTINUE;
}

// ---------------------------------------------------------------------------
// browser 进程入口（iris_bootstrap_main 在 CefExecuteProcess 之后调用）
// ---------------------------------------------------------------------------

static int32_t SampleAppMain(void* user_data) {
  char error[256];
  uint16_t* cache_utf16 = NULL;
  size_t cache_utf16_len = 0;
  char cache_default[MAX_PATH];

  const SampleArguments* arguments = (const SampleArguments*)user_data;
  if (!ParseOptions(arguments->argc, arguments->argv, error, sizeof(error))) {
    fprintf(stderr, "[sample] %s\n", error);
    return IRIS_INVALID_ARGUMENT;
  }

  const char* cache_dir = g_options.cache_dir;
  if (!cache_dir) {
    char temp[MAX_PATH];
    DWORD length = GetTempPathA(MAX_PATH, temp);
    if (length == 0 || length >= MAX_PATH) {
      fprintf(stderr, "[sample] cannot resolve temp dir\n");
      return IRIS_INITIALIZATION_FAILED;
    }
    _snprintf(cache_default, sizeof(cache_default), "%siris-c-sample", temp);
    cache_default[sizeof(cache_default) - 1] = '\0';
    cache_dir = cache_default;
  }

  cache_utf16 = DuplicateUtf8AsUtf16(cache_dir, &cache_utf16_len);
  if (!cache_utf16) {
    fprintf(stderr, "[sample] cache path conversion failed\n");
    return IRIS_INVALID_ARGUMENT;
  }

  iris_config_t config;
  memset(&config, 0, sizeof(config));
  config.struct_size = sizeof(config);
  config.seed = g_options.seed;
  config.window_mode =
      g_options.windowless ? IRIS_WINDOW_MODE_WINDOWLESS : IRIS_WINDOW_MODE_WINDOWED;
  config.remote_debugging_port = (uint32_t)g_options.cdp_port;
  config.cache_path_utf16.data = cache_utf16;
  config.cache_path_utf16.len = cache_utf16_len;
  if (g_options.timezone && g_options.timezone[0] != '\0') {
    config.timezone_utf8.data = (const uint8_t*)g_options.timezone;
    config.timezone_utf8.len = strlen(g_options.timezone);
  }

  printf("[sample] run: url=%s seed=%llu mode=%s cache=%s timezone=%s\n",
         g_options.url, g_options.seed,
         g_options.windowless ? "windowless" : "windowed", cache_dir,
         (g_options.timezone && g_options.timezone[0]) ? g_options.timezone
                                                       : "<host>");
  fflush(stdout);

  const iris_status_t result = iris_run(&config, &OnEvent, NULL);
  printf("[sample] iris_run finished: %d/%d\n", result.code,
         result.native_code);
  fflush(stdout);

  free(cache_utf16);
  return result.code == IRIS_OK ? (g_failed || !g_navigated ? 1 : 0) : result.code;
}

// ---------------------------------------------------------------------------
// 标准客户端 DLL 导出：bootstrapc.exe 经 GetProcAddress 调用。
// 参数与 cef_sandbox_win.h 的 RunConsoleMain ABI 一致；version_info 按不透明
// 指针原样转交。
// ---------------------------------------------------------------------------

__declspec(dllexport) int RunConsoleMain(int argc,
                                         char** argv,
                                         void* sandbox_info,
                                         void* version_info) {
  SampleArguments arguments = {argc, argv};
  return iris_bootstrap_main(argc, argv, sandbox_info, version_info,
                             &SampleAppMain, &arguments);
}
