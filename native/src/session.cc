// SessionCore：CEF 生命周期、事件队列、CDP 适配与全部会话 API 实现。
//
// 线程模型：multi_threaded_message_loop=false，主线程即 UI 线程。所有
// CefInitialize → CefRunMessageLoop → OnBeforeClose 全部 → 注销 DevTools
// registration → 释放全部 CefRefPtr → CefShutdown 均发生在该线程。
//
// 事件交付：native 先排队事件，再由 UI 任务（DrainTask）串行调用宿主回调；
// 回调内可同步调用会话 API（同线程），回调绝不重入。
//
// 命令超时：每条命令提交时经 CefPostDelayedTask 安排 30 秒延迟任务；超时
// 投递 IRIS_TIMEOUT 并移除待定项，迟到结果按 native message id 忽略。

#include "iris_internal.h"

#include <algorithm>
#include <cstdio>
#include <filesystem>
#include <limits>
#include <stdexcept>
#include <string_view>
#include <utility>

#include "include/cef_command_line.h"
#include "include/cef_display_handler.h"
#include "include/cef_frame.h"
#include "include/cef_parser.h"
#include "include/cef_render_handler.h"
#include "include/cef_task.h"
#include "include/cef_values.h"

#include "include/iris_profile_data.h"

namespace iris {

constexpr std::wstring_view kWindowTitle = L"StraviaIris";

// ---------------------------------------------------------------------------
// 视图与 JSON 工具
// ---------------------------------------------------------------------------

bool Utf8ViewValid(const iris_utf8_t& view) {
  if (view.len == 0) {
    return true;  // 空视图：data 允许为 null。
  }
  if (!view.data || view.len > static_cast<size_t>(std::numeric_limits<int>::max())) {
    return false;
  }
  return std::find(view.data, view.data + view.len, uint8_t{0}) ==
             view.data + view.len &&
         ::MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS,
                               reinterpret_cast<const char*>(view.data),
                               static_cast<int>(view.len), nullptr, 0) != 0;
}

bool Utf16ViewValid(const iris_utf16_t& view) {
  if (view.len == 0) {
    return true;
  }
  if (!view.data) {
    return false;
  }
  return std::find(view.data, view.data + view.len, uint16_t{0}) ==
         view.data + view.len;
}

std::string Utf8FromStringView(const iris_utf8_t& view) {
  if (view.len == 0 || !view.data) {
    return std::string();
  }
  return std::string(reinterpret_cast<const char*>(view.data), view.len);
}

std::wstring WideFromUtf16View(const iris_utf16_t& view) {
  if (view.len == 0 || !view.data) {
    return std::wstring();
  }
  // Windows 上 wchar_t 与 uint16_t 同宽，直接逐元素转换。
  return std::wstring(view.data, view.data + view.len);
}

namespace {

CefRefPtr<CefValue> ParseJson(const std::string& text) {
  // 严格模式（0）：CDP 输入不允许尾随逗号等宽松语法。
  return CefParseJSON(text.data(), text.size(),
                      static_cast<cef_json_parser_options_t>(0));
}

std::string WriteJson(CefRefPtr<CefValue> node) {
  return CefWriteJSON(node, JSON_WRITER_DEFAULT).ToString();
}

}  // namespace

std::string EmptyPayload() {
  return "{}";
}

std::string LoadErrorPayload(int32_t code,
                             const std::string& message,
                             const std::string& url) {
  CefRefPtr<CefDictionaryValue> dict = CefDictionaryValue::Create();
  dict->SetInt("code", code);
  dict->SetString("message", message);
  dict->SetString("url", url);
  CefRefPtr<CefValue> value = CefValue::Create();
  value->SetDictionary(dict);
  return WriteJson(value);
}

std::string RendererTerminatedPayload(int32_t status, int32_t error_code) {
  CefRefPtr<CefDictionaryValue> dict = CefDictionaryValue::Create();
  dict->SetInt("status", status);
  dict->SetInt("error_code", error_code);
  CefRefPtr<CefValue> value = CefValue::Create();
  value->SetDictionary(dict);
  return WriteJson(value);
}

std::string ProtocolEventPayload(const std::string& method,
                                 const std::string& params_json) {
  CefRefPtr<CefDictionaryValue> dict = CefDictionaryValue::Create();
  dict->SetString("method", method);
  CefRefPtr<CefDictionaryValue> params = CefDictionaryValue::Create();
  if (!params_json.empty()) {
    CefRefPtr<CefValue> parsed = ParseJson(params_json);
    if (!parsed || !(parsed->GetType() == VTYPE_DICTIONARY)) {
      throw std::runtime_error("CEF DevTools event params are not an object");
    }
    params = parsed->GetDictionary();
  }
  dict->SetDictionary("params", params);
  CefRefPtr<CefValue> value = CefValue::Create();
  value->SetDictionary(dict);
  return WriteJson(value);
}

std::string NormalizeResultPayload(const void* result, size_t result_size) {
  if (!result && result_size != 0) {
    throw std::runtime_error("CEF DevTools result has a null nonempty view");
  }
  if (result_size == 0) {
    return EmptyPayload();
  }
  const char* text = static_cast<const char*>(result);
  std::string payload(text, result_size);
  CefRefPtr<CefValue> parsed = ParseJson(payload);
  if (!parsed || !(parsed->GetType() == VTYPE_DICTIONARY)) {
    throw std::runtime_error("CEF DevTools result is not an object");
  }
  return payload;
}

// ---------------------------------------------------------------------------
// UI 线程任务
// ---------------------------------------------------------------------------

class DrainTask final : public CefTask {
 public:
  explicit DrainTask(SessionCore* core) : core_(core) {}

  void Execute() override {
    core_->ProtectCallback([&] { core_->RunDrain(); });
  }

 private:
  SessionCore* core_;
  IMPLEMENT_REFCOUNTING(DrainTask);
};

class CommandTimeoutTask final : public CefTask {
 public:
  CommandTimeoutTask(SessionCore* core, uint64_t public_request)
      : core_(core), public_request_(public_request) {}

  void Execute() override {
    core_->ProtectCallback([&] { core_->OnCommandTimeout(public_request_); });
  }

 private:
  SessionCore* core_;
  uint64_t public_request_;
  IMPLEMENT_REFCOUNTING(CommandTimeoutTask);
};

// ---------------------------------------------------------------------------
// CefApp：浏览器进程命令行与上下文初始化
// ---------------------------------------------------------------------------

class IrisAppImpl final : public CefApp, public CefBrowserProcessHandler {
 public:
  explicit IrisAppImpl(SessionCore* core) : core_(core) {}

  void OnBeforeCommandLineProcessing(
      const CefString& process_type,
      CefRefPtr<CefCommandLine> command_line) override {
    core_->ProtectCallback([&] {
      core_->OnBeforeCommandLineProcessing(process_type, command_line);
    });
  }

  void OnContextInitialized() override {
    core_->ProtectCallback([&] { core_->OnContextInitialized(); });
  }

  bool OnAlreadyRunningAppRelaunch(
      CefRefPtr<CefCommandLine>,
      const CefString&) override {
    // 重复 cache 的进程必须失败，不能让 CEF 默认行为在已有实例中
    // 创建未由 SDK 跟踪的 Chrome 窗口，破坏 shutdown 的所有权边界。
    return true;
  }

  CefRefPtr<CefBrowserProcessHandler> GetBrowserProcessHandler() override {
    return this;
  }

 private:
  SessionCore* core_;
  IMPLEMENT_REFCOUNTING(IrisAppImpl);
};

// ---------------------------------------------------------------------------
// CefClient：生命周期/加载/请求/OSR 渲染/CDP 观察者（全部 UI 线程）
// ---------------------------------------------------------------------------

class IrisClientImpl final : public CefClient,
                             public CefDisplayHandler,
                             public CefLifeSpanHandler,
                             public CefLoadHandler,
                             public CefRequestHandler,
                             public CefRenderHandler,
                             public CefDevToolsMessageObserver {
 public:
  explicit IrisClientImpl(SessionCore* core,
                          std::optional<PopupKey> popup = std::nullopt)
      : core_(core), popup_(popup) {}

  // CefClient
  CefRefPtr<CefDisplayHandler> GetDisplayHandler() override { return this; }
  CefRefPtr<CefLifeSpanHandler> GetLifeSpanHandler() override { return this; }
  CefRefPtr<CefLoadHandler> GetLoadHandler() override { return this; }
  CefRefPtr<CefRequestHandler> GetRequestHandler() override { return this; }
  CefRefPtr<CefRenderHandler> GetRenderHandler() override { return this; }

  void OnTitleChange(CefRefPtr<CefBrowser> browser,
                     const CefString& title) override {
    core_->ProtectCallback([&] {
      const auto host = browser->GetHost();
      if (host->IsWindowRenderingDisabled()) {
        return;
      }
      const HWND window = host->GetWindowHandle();
      if (!window) {
        return;
      }
      // 只更新系统标题，不修改 document.title 或窗口样式/客户区尺寸。
      std::wstring caption;
      caption.reserve(kWindowTitle.size() + 3 + title.length());
      caption.append(kWindowTitle);
      if (!title.empty()) {
        caption.append(L" — ");
        caption.append(title.c_str(), title.c_str() + title.length());
      }
      if (!SetWindowTextW(window, caption.c_str())) {
        std::fprintf(stderr, "iris: SetWindowTextW failed: %lu\n",
                     static_cast<unsigned long>(GetLastError()));
      }
    });
  }

  // CefLifeSpanHandler：popup 按上游正常创建，继承同一 profile/客户端。
  bool OnBeforePopup(CefRefPtr<CefBrowser> browser,
                     CefRefPtr<CefFrame> frame,
                     int popup_id,
                     const CefString& target_url,
                     const CefString& target_frame_name,
                     CefLifeSpanHandler::WindowOpenDisposition target_disposition,
                     bool user_gesture,
                     const CefPopupFeatures& popupFeatures,
                     CefWindowInfo& windowInfo,
                     CefRefPtr<CefClient>& client,
                     CefBrowserSettings& settings,
                     CefRefPtr<CefDictionaryValue>& extra_info,
                     bool* no_javascript_access) override {
    UNREFERENCED_PARAMETER(browser);
    UNREFERENCED_PARAMETER(frame);
    UNREFERENCED_PARAMETER(popup_id);
    UNREFERENCED_PARAMETER(target_url);
    UNREFERENCED_PARAMETER(target_frame_name);
    UNREFERENCED_PARAMETER(target_disposition);
    UNREFERENCED_PARAMETER(user_gesture);
    UNREFERENCED_PARAMETER(popupFeatures);
    UNREFERENCED_PARAMETER(windowInfo);
    UNREFERENCED_PARAMETER(client);
    UNREFERENCED_PARAMETER(settings);
    UNREFERENCED_PARAMETER(extra_info);
    UNREFERENCED_PARAMETER(no_javascript_access);
    bool cancel = true;
    core_->ProtectCallback([&] {
      const PopupKey key{browser->GetIdentifier(), popup_id};
      CefRefPtr<IrisClientImpl> popup_client = new IrisClientImpl(core_, key);
      cancel = core_->OnBeforePopup(key);
      if (!cancel) {
        client = popup_client;
      }
    });
    return cancel;
  }

  void OnBeforePopupAborted(CefRefPtr<CefBrowser> browser,
                            int popup_id) override {
    UNREFERENCED_PARAMETER(browser);
    UNREFERENCED_PARAMETER(popup_id);
    core_->ProtectCallback([&] {
      core_->OnBeforePopupAborted({browser->GetIdentifier(), popup_id});
    });
  }

  void OnAfterCreated(CefRefPtr<CefBrowser> browser) override {
    core_->ProtectCallback([&] { core_->OnAfterCreated(browser, popup_); });
  }

  void OnBeforeClose(CefRefPtr<CefBrowser> browser) override {
    core_->ProtectCallback([&] { core_->OnBeforeClose(browser); });
  }

  // CefLoadHandler：仅主框架失败投递 LoadError。
  void OnLoadError(CefRefPtr<CefBrowser> browser,
                   CefRefPtr<CefFrame> frame,
                   ErrorCode errorCode,
                   const CefString& errorText,
                   const CefString& failedUrl) override {
    core_->ProtectCallback([&] {
      core_->OnLoadError(browser, frame, static_cast<int32_t>(errorCode),
                         errorText, failedUrl);
    });
  }

  // CefRequestHandler：渲染进程终止 → RendererTerminated + 取消待定命令。
  void OnRenderProcessTerminated(CefRefPtr<CefBrowser> browser,
                                 TerminationStatus status,
                                 int error_code,
                                 const CefString& error_string) override {
    UNREFERENCED_PARAMETER(error_string);
    core_->ProtectCallback([&] {
      core_->OnRenderProcessTerminated(browser, static_cast<int32_t>(status),
                                       error_code);
    });
  }

  // CefRenderHandler：OSR 尺寸与虚拟屏幕参数（profile 唯一来源）。
  void GetViewRect(CefRefPtr<CefBrowser> browser, CefRect& rect) override {
    UNREFERENCED_PARAMETER(browser);
    rect = CefRect(0, 0, profile::kViewportWidth, profile::kViewportHeight);
  }

  bool GetScreenInfo(CefRefPtr<CefBrowser> browser,
                     CefScreenInfo& screen_info) override {
    UNREFERENCED_PARAMETER(browser);
    screen_info.device_scale_factor =
        static_cast<float>(profile::kDeviceScaleFactor);
    screen_info.depth = profile::kColorDepth;
    screen_info.depth_per_component = profile::kDepthPerComponent;
    screen_info.rect =
        CefRect(0, 0, profile::kScreenWidth, profile::kScreenHeight);
    screen_info.available_rect =
        CefRect(0, 0, profile::kAvailableWidth, profile::kAvailableHeight);
    return true;
  }

  void OnPaint(CefRefPtr<CefBrowser> browser,
               PaintElementType type,
               const RectList& dirtyRects,
               const void* buffer,
               int width,
               int height) override {
    // 截图走 CDP Page.captureScreenshot；CPU 绘制回调无需保留像素。
    UNREFERENCED_PARAMETER(browser);
    UNREFERENCED_PARAMETER(type);
    UNREFERENCED_PARAMETER(dirtyRects);
    UNREFERENCED_PARAMETER(buffer);
    UNREFERENCED_PARAMETER(width);
    UNREFERENCED_PARAMETER(height);
  }

  // CefDevToolsMessageObserver
  void OnDevToolsMethodResult(CefRefPtr<CefBrowser> browser,
                              int message_id,
                              bool success,
                              const void* result,
                              size_t result_size) override {
    core_->ProtectCallback([&] {
      core_->OnDevToolsMethodResult(browser, message_id, success, result,
                                    result_size);
    });
  }

  void OnDevToolsEvent(CefRefPtr<CefBrowser> browser,
                       const CefString& method,
                       const void* params,
                       size_t params_size) override {
    core_->ProtectCallback([&] {
      core_->OnDevToolsEvent(browser, method, params, params_size);
    });
  }

  void OnDevToolsAgentDetached(CefRefPtr<CefBrowser> browser) override {
    core_->ProtectCallback([&] { core_->OnDevToolsAgentDetached(browser); });
  }

 private:
  SessionCore* core_;
  std::optional<PopupKey> popup_;
  IMPLEMENT_REFCOUNTING(IrisClientImpl);
};

// ---------------------------------------------------------------------------
// SessionCore
// ---------------------------------------------------------------------------

SessionCore::SessionCore() = default;

SessionCore::~SessionCore() = default;

bool SessionCore::OnSessionThread() const {
  return ::GetCurrentThreadId() == GetBootstrap().main_thread_id;
}

BrowserEntry* SessionCore::FindByCefId(int cef_id) {
  auto it = public_by_cef_id_.find(cef_id);
  if (it == public_by_cef_id_.end()) {
    return nullptr;
  }
  auto entry = browsers_.find(it->second);
  return entry == browsers_.end() ? nullptr : &entry->second;
}

BrowserEntry* SessionCore::FindByPublicId(iris_browser_id_t public_id) {
  auto entry = browsers_.find(public_id);
  return entry == browsers_.end() ? nullptr : &entry->second;
}

// ---- 启动命令行：SDK 注入 profile 开关，子进程传播由引擎补丁完成 ----

void SessionCore::OnBeforeCommandLineProcessing(
    const CefString& process_type,
    CefRefPtr<CefCommandLine> command_line) {
  if (!process_type.empty()) {
    // 子进程命令行由引擎补丁从 browser 进程传播，SDK 不重复注入。
    return;
  }
  // 禁止 Chromium 参数透传，但保留 bootstrap 已验证的客户端模块选择。
  auto bootstrap_command = CefCommandLine::CreateCommandLine();
  bootstrap_command->InitFromString(::GetCommandLineW());
  if (bootstrap_command->HasSwitch("module")) {
    command_line->AppendSwitchWithValue(
        "module", bootstrap_command->GetSwitchValue("module"));
  }
  command_line->AppendSwitchWithValue("iris-seed", std::to_string(seed_));
  if (!timezone_.empty()) {
    command_line->AppendSwitchWithValue("iris-timezone", timezone_);
  }
}

// ---- OnContextInitialized：WebRTC 偏好校验后才开放 Ready/创建 ----

void SessionCore::OnContextInitialized() {
  context_initialized_ = true;

  // 原生策略 blink::kWebRTCIPHandlingDefault 对应的 preference
  // 必须由引擎补丁在 browser context 注册；未注册或不可写时启动失败，
  // 绝不伪造一个未被消费的配置项。default 下发通配地址候选项，
  // 不暴露宿主真实 IP（无 mDNS responder 时为 0.0.0.0/::）。
  constexpr char kWebRtcIpHandlingPolicy[] = "webrtc.ip_handling_policy";
  CefRefPtr<CefRequestContext> context = CefRequestContext::GetGlobalContext();
  if (!context || !context->CanSetPreference(kWebRtcIpHandlingPolicy)) {
    std::fprintf(stderr, "iris: global request context %s: %s\n",
                 context ? "cannot modify preference" : "unavailable",
                 kWebRtcIpHandlingPolicy);
    FailRun(Status(IRIS_INITIALIZATION_FAILED));
    return;
  }
  CefRefPtr<CefValue> value = CefValue::Create();
  value->SetString("default");
  CefString error;
  if (!context->SetPreference(kWebRtcIpHandlingPolicy, value, error)) {
    std::fprintf(stderr, "iris: cannot set %s: %s\n", kWebRtcIpHandlingPolicy,
                 error.ToString().c_str());
    FailRun(Status(IRIS_INITIALIZATION_FAILED));
    return;
  }
  preference_verified_ = true;
  TryDeliverReady();
}

void SessionCore::OnDebuggingResult(int32_t status,
                                    int32_t native_error,
                                    uint32_t port) {
  if (shutting_down_ || ready_delivered_) {
    return;
  }
  debugging_result_arrived_ = true;
  debugging_status_ = status;
  debugging_native_error_ = native_error;
  debugging_port_ = port;
  TryDeliverReady();
}

void OnEngineDebuggingResult(int32_t status,
                             int32_t native_error,
                             uint32_t port,
                             void* user_data) {
  // 私有引擎接口保证 UI 线程与已登记的 core 借用期，不推测端口就绪。
  if (user_data) {
    auto* core = static_cast<SessionCore*>(user_data);
    core->ProtectCallback([&] {
      core->OnDebuggingResult(status, native_error, port);
    });
  }
}

void SessionCore::TryDeliverReady() {
  if (!initialized_ || ready_delivered_ || run_error_.code != IRIS_OK) {
    return;
  }
  if (!context_initialized_ || !preference_verified_) {
    return;
  }
  if (remote_debugging_port_ != 0 && !debugging_result_arrived_) {
    // 等待引擎在 UI 线程交付真实端点结果；不以日志/探测推断就绪。
    return;
  }
  if (remote_debugging_port_ != 0) {
    if (debugging_status_ != 0) {
      std::fprintf(stderr, "iris: DevTools start failed: status=%d native=%d\n",
                   debugging_status_, debugging_native_error_);
      FailRun(Status(IRIS_INITIALIZATION_FAILED, debugging_native_error_));
      return;
    }
    if (debugging_port_ != remote_debugging_port_) {
      std::fprintf(stderr, "iris: DevTools port mismatch: actual=%u requested=%u\n",
                   debugging_port_, remote_debugging_port_);
      // 被占用时引擎可能绑定其他端口：SDK 要求与请求一致，不自动接受。
      FailRun(Status(IRIS_INITIALIZATION_FAILED, 0));
      return;
    }
  }
  ready_delivered_ = true;
  QueueEvent(IRIS_EVENT_READY, 0, 0, OkStatus(), EmptyPayload());
}

void SessionCore::FailRun(iris_status_t status) {
  if (run_error_.code == IRIS_OK) {
    run_error_ = status;
  }
  shutdown_requested_ = true;
  if (initialized_) {
    ForceCloseAll();
  }
  ScheduleDrain();
}

void SessionCore::CallbackFailed() noexcept {
  std::fputs("iris: native callback threw an exception\n", stderr);
  try {
    FailRun(Status(IRIS_INITIALIZATION_FAILED));
  } catch (...) {
    // 连关闭本身都无法继续（例如再次分配失败）时不能伪造正常退出或跨 ABI unwind。
    std::terminate();
  }
}

uint64_t SessionCore::AllocateBrowserId() {
  if (browser_ids_exhausted_) {
    return 0;
  }
  const uint64_t id = next_browser_id_++;
  browser_ids_exhausted_ = next_browser_id_ == 0;
  return id;
}

// ---- 生命周期回调 ----

bool SessionCore::OnBeforePopup(PopupKey popup) {
  if (shutdown_requested_ || browser_ids_exhausted_) {
    return true;
  }
  const auto id = AllocateBrowserId();
  if (!id || !pending_popups_.emplace(popup, id).second) {
    return true;
  }
  return false;
}

void SessionCore::OnBeforePopupAborted(PopupKey popup) {
  auto pending = pending_popups_.find(popup);
  if (pending != pending_popups_.end()) {
    const auto id = pending->second;
    pending_popups_.erase(pending);
    QueueEvent(IRIS_EVENT_LOAD_ERROR, id, 0, Status(IRIS_INITIALIZATION_FAILED),
               LoadErrorPayload(0, "Browser creation failed", ""));
  }
  ScheduleDrain();  // shutdown 可能因 popup 终止而满足退出条件。
}

void SessionCore::OnAfterCreated(CefRefPtr<CefBrowser> browser,
                                 const std::optional<PopupKey>& popup) {
  uint64_t public_id = 0;
  if (popup) {
    auto pending = pending_popups_.find(*popup);
    if (pending != pending_popups_.end()) {
      public_id = pending->second;
      pending_popups_.erase(pending);
    }
  } else if (sync_create_in_flight_) {
    // CreateBrowserSync 同步触发的 SDK 显式创建：与 pending ID 配对。
    sync_create_in_flight_ = false;
    public_id = sync_create_pending_id_;
  }
  if (!public_id) {
    ++untracked_closing_count_;
    browser->GetHost()->CloseBrowser(true);
    FailRun(Status(IRIS_INITIALIZATION_FAILED));
    return;
  }
  ever_created_ = true;

  const int cef_id = browser->GetIdentifier();
  try {
    BrowserEntry entry;
    entry.public_id = public_id;
    entry.cef_id = cef_id;
    entry.browser = browser;
    browsers_.emplace(public_id, std::move(entry));
    public_by_cef_id_.emplace(cef_id, public_id);
  } catch (...) {
    browsers_.erase(public_id);
    public_by_cef_id_.erase(cef_id);
    ++untracked_closing_count_;
    browser->GetHost()->CloseBrowser(true);
    throw;
  }
  auto& entry = browsers_.at(public_id);
  entry.devtools_registration = browser->GetHost()->AddDevToolsMessageObserver(client_);
  if (!entry.devtools_registration) {
    FailRun(Status(IRIS_INITIALIZATION_FAILED));
    return;
  }

  QueueEvent(IRIS_EVENT_BROWSER_CREATED, public_id, 0, OkStatus(),
             EmptyPayload());
  if (shutdown_requested_) {
    ForceCloseAll();
  }
}

void SessionCore::OnBeforeClose(CefRefPtr<CefBrowser> browser) {
  const int cef_id = browser->GetIdentifier();
  auto public_it = public_by_cef_id_.find(cef_id);
  if (public_it == public_by_cef_id_.end()) {
    if (untracked_closing_count_) {
      --untracked_closing_count_;
      ScheduleDrain();
    }
    return;
  }
  const iris_browser_id_t public_id = public_it->second;
  public_by_cef_id_.erase(public_it);

  auto entry = browsers_.find(public_id);
  if (entry != browsers_.end()) {
    // 在 CefShutdown 前释放全部 CEF 引用（含 DevTools registration）。
    entry->second.devtools_registration = nullptr;
    entry->second.browser = nullptr;
    entry->second.native_closed = true;
    if (drain_failed_) {
      browsers_.erase(entry);
    }
  }

  // 先完成不分配内存的生命周期移除，避免事件分配失败留下永远无法关闭的项。
  CancelPendingForBrowser(public_id, IRIS_COMMAND_CANCELLED);
  QueueEvent(IRIS_EVENT_BROWSER_CLOSED, public_id, 0, OkStatus(),
             EmptyPayload());
}

void SessionCore::OnLoadError(CefRefPtr<CefBrowser> browser,
                              CefRefPtr<CefFrame> frame,
                              int32_t code,
                              const CefString& message,
                              const CefString& url) {
  if (!frame || !frame->IsMain()) {
    return;
  }
  BrowserEntry* entry = FindByCefId(browser->GetIdentifier());
  if (!entry) {
    return;
  }
  QueueEvent(IRIS_EVENT_LOAD_ERROR, entry->public_id, 0, OkStatus(),
             LoadErrorPayload(code, message.ToString(), url.ToString()));
}

void SessionCore::OnRenderProcessTerminated(CefRefPtr<CefBrowser> browser,
                                            int32_t status,
                                            int32_t error_code) {
  BrowserEntry* entry = FindByCefId(browser->GetIdentifier());
  if (!entry) {
    return;
  }
  QueueEvent(IRIS_EVENT_RENDERER_TERMINATED, entry->public_id, 0,
             Status(IRIS_RENDERER_TERMINATED, error_code),
             RendererTerminatedPayload(status, error_code));
  CancelPendingForBrowser(entry->public_id, IRIS_COMMAND_CANCELLED);
}

// ---- CDP ----

void SessionCore::OnDevToolsMethodResult(CefRefPtr<CefBrowser> browser,
                                         int message_id,
                                         bool success,
                                         const void* result,
                                         size_t result_size) {
  UNREFERENCED_PARAMETER(browser);
  auto it = pending_by_native_id_.find(message_id);
  if (it == pending_by_native_id_.end()) {
    return;  // 已超时/取消的迟到结果：忽略。
  }
  const PendingCommand pending = it->second;
  pending_by_native_id_.erase(it);
  native_by_public_request_.erase(pending.public_request);
  QueueEvent(IRIS_EVENT_COMMAND_RESULT, pending.browser, pending.public_request,
             Status(success ? IRIS_OK : IRIS_PROTOCOL, 0),
             NormalizeResultPayload(result, result_size));
}

void SessionCore::OnDevToolsEvent(CefRefPtr<CefBrowser> browser,
                                  const CefString& method,
                                  const void* params,
                                  size_t params_size) {
  BrowserEntry* entry = FindByCefId(browser->GetIdentifier());
  if (!entry) {
    return;
  }
  std::string params_json;
  if (!params && params_size != 0) {
    throw std::runtime_error("CEF DevTools params has a null nonempty view");
  }
  if (params_size > 0) {
    params_json.assign(static_cast<const char*>(params), params_size);
  }
  QueueEvent(IRIS_EVENT_PROTOCOL_EVENT, entry->public_id, 0, OkStatus(),
             ProtocolEventPayload(method.ToString(), params_json));
}

void SessionCore::OnDevToolsAgentDetached(CefRefPtr<CefBrowser> browser) {
  BrowserEntry* entry = FindByCefId(browser->GetIdentifier());
  if (!entry) {
    return;
  }
  CancelPendingForBrowser(entry->public_id, IRIS_COMMAND_CANCELLED);
}

void SessionCore::CancelPendingForBrowser(iris_browser_id_t browser,
                                          int32_t code) {
  for (auto it = pending_by_native_id_.begin();
       it != pending_by_native_id_.end();) {
    if (it->second.browser == browser) {
      const PendingCommand pending = it->second;
      native_by_public_request_.erase(pending.public_request);
      it = pending_by_native_id_.erase(it);
      QueueEvent(IRIS_EVENT_COMMAND_RESULT, pending.browser,
                 pending.public_request, Status(code, 0), EmptyPayload());
    } else {
      ++it;
    }
  }
}

void SessionCore::OnCommandTimeout(uint64_t public_request) {
  if (shutting_down_) {
    return;
  }
  auto native_it = native_by_public_request_.find(public_request);
  if (native_it == native_by_public_request_.end()) {
    return;  // 已完成/取消：任务过期。
  }
  const int native_id = native_it->second;
  native_by_public_request_.erase(native_it);
  auto it = pending_by_native_id_.find(native_id);
  if (it == pending_by_native_id_.end()) {
    return;
  }
  const PendingCommand pending = it->second;
  pending_by_native_id_.erase(it);
  QueueEvent(IRIS_EVENT_COMMAND_RESULT, pending.browser, public_request,
             Status(IRIS_TIMEOUT, 0), EmptyPayload());
}

// ---- 事件队列与 drain ----

void SessionCore::QueueEvent(uint32_t kind,
                             iris_browser_id_t browser,
                             iris_request_id_t request,
                             iris_status_t status,
                             std::string payload) {
  if (shutting_down_) {
    return;
  }
  if (drain_failed_) {
    MaybeQuit();
    return;
  }
  QueuedEvent event;
  event.kind = kind;
  event.browser = browser;
  event.request = request;
  event.status = status;
  event.payload = std::move(payload);
  queue_.push_back(std::move(event));
  ScheduleDrain();
}

void SessionCore::ScheduleDrain() {
  if (!initialized_ || shutting_down_ || drain_posted_ || draining_) {
    return;
  }
  if (drain_failed_) {
    MaybeQuit();
    return;
  }
  drain_posted_ = true;
  if (!CefPostTask(TID_UI, new DrainTask(this))) {
    drain_posted_ = false;
    drain_failed_ = true;
    if (run_error_.code == IRIS_OK) {
      run_error_ = Status(IRIS_INITIALIZATION_FAILED);
    }
    shutdown_requested_ = true;
    queue_.clear();
    std::erase_if(browsers_, [](const auto& pair) {
      return pair.second.native_closed;
    });
    ForceCloseAll();
    MaybeQuit();
  }
}

void SessionCore::RunDrain() {
  drain_posted_ = false;
  if (draining_ || shutting_down_) {
    return;
  }
  draining_ = true;
  try {
  // 串行交付；回调内新事件进入同一队列，由本循环继续处理（不重入回调）。
  while (!queue_.empty()) {
    QueuedEvent event = std::move(queue_.front());
    queue_.pop_front();

    iris_event_t delivery{};
    delivery.kind = event.kind;
    delivery.browser = event.browser;
    delivery.request = event.request;
    delivery.status = event.status;
    delivery.payload_json.data =
        reinterpret_cast<const uint8_t*>(event.payload.c_str());
    delivery.payload_json.len = event.payload.size();

    if (event.kind == IRIS_EVENT_BROWSER_CREATED) {
      if (auto* entry = FindByPublicId(event.browser)) {
        entry->created_delivered = true;
      }
    } else if (event.kind == IRIS_EVENT_BROWSER_CLOSED) {
      browsers_.erase(event.browser);
    }
    if (!next_callback_token_) {
      drain_failed_ = true;
      queue_.clear();
      std::erase_if(browsers_, [](const auto& pair) {
        return pair.second.native_closed;
      });
      FailRun(Status(IRIS_INITIALIZATION_FAILED));
      break;
    }
    // Windows x64 opaque token 不指向对象；每次回调唯一，只比较、绝不解引用。
    auto* token = reinterpret_cast<iris_session_t*>(next_callback_token_++);
    auto& bootstrap = GetBootstrap();
    bootstrap.active_core = this;
    bootstrap.active_session.store(token);
    callback_active_ = true;
    uint32_t result = IRIS_CALLBACK_PANICKED;
    try {
      result = callback_(token, &delivery, user_data_);
    } catch (...) {
      // C/C++ consumer 也可能抛异常，转入与 Rust panic 相同的完整关闭路径。
    }
    bootstrap.active_session.store(nullptr);
    bootstrap.active_core = nullptr;
    callback_active_ = false;
    HandleCallbackResult(result);
  }
  } catch (...) {
    GetBootstrap().active_session.store(nullptr);
    GetBootstrap().active_core = nullptr;
    callback_active_ = false;
    draining_ = false;
    throw;
  }
  draining_ = false;
  MaybeQuit();
}

void SessionCore::HandleCallbackResult(uint32_t result) {
  switch (result) {
    case IRIS_CALLBACK_CONTINUE:
      return;
    case IRIS_CALLBACK_SHUTDOWN:
      shutdown_requested_ = true;
      ForceCloseAll();
      return;
    case IRIS_CALLBACK_PANICKED:
      if (run_error_.code == IRIS_OK) {
        run_error_ = Status(IRIS_CALLBACK_PANICKED, 0);
      }
      shutdown_requested_ = true;
      ForceCloseAll();
      return;
    default:
      // 非法返回值按 InvalidArgument 关闭运行。
      if (run_error_.code == IRIS_OK) {
        run_error_ = Status(IRIS_INVALID_ARGUMENT, 0);
      }
      shutdown_requested_ = true;
      ForceCloseAll();
      return;
  }
}

void SessionCore::ForceCloseAll() {
  uint64_t previous = 0;
  for (auto it = browsers_.upper_bound(previous); it != browsers_.end();
       it = browsers_.upper_bound(previous)) {
    previous = it->first;
    if (!it->second.closing && it->second.browser) {
      it->second.closing = true;
      // CloseBrowser 可能触发同步回调，不跨该调用保留 map 迭代器。
      CefRefPtr<CefBrowser> browser = it->second.browser;
      browser->GetHost()->CloseBrowser(true);
    }
  }
}

void SessionCore::MaybeQuit() {
  if (!loop_running_ || shutting_down_) {
    return;
  }
  if (!browsers_.empty() || !pending_popups_.empty() ||
      untracked_closing_count_ != 0 || !queue_.empty()) {
    return;
  }
  // 无 browser 时不自行退出；已创建过 browser 则在最后一个关闭事件交付后退出。
  if (shutdown_requested_ || ever_created_) {
    CefQuitMessageLoop();
  }
}

// ---- 会话 API ----

iris_status_t SessionCore::CreateBrowser(const iris_utf8_t& url,
                                         iris_browser_id_t* browser_out) {
  if (!ready_delivered_ || shutdown_requested_) {
    return Status(IRIS_NOT_READY, 0);
  }
  if (!browser_out || !Utf8ViewValid(url) || url.len == 0) {
    return Status(IRIS_INVALID_ARGUMENT, 0);
  }
  const std::string url_text = Utf8FromStringView(url);

  // URL 合法性：复用 CEF 解析器（覆盖 about:blank/data: 等标准形式）。
  CefURLParts parts{};
  if (!CefParseURL(url_text, parts)) {
    return Status(IRIS_INVALID_ARGUMENT, 0);
  }

  const uint64_t pending_id = AllocateBrowserId();
  if (!pending_id) {
    return Status(IRIS_INVALID_ARGUMENT, 0);
  }

  CefWindowInfo window_info;
  if (windowless_) {
    // OSR：SetAsWindowless 同时固定 Alloy 风格。
    window_info.SetAsWindowless(nullptr);
  } else {
    window_info.SetAsPopup(nullptr, kWindowTitle.data());
    window_info.runtime_style = CEF_RUNTIME_STYLE_ALLOY;
  }
  window_info.bounds =
      CefRect(0, 0, profile::kViewportWidth, profile::kViewportHeight);

  CefBrowserSettings settings;
  sync_create_in_flight_ = true;
  sync_create_pending_id_ = pending_id;
  struct SyncCreationScope {
    bool& active;
    ~SyncCreationScope() { active = false; }
  } creation_scope{sync_create_in_flight_};
  CefRefPtr<CefBrowser> browser = CefBrowserHost::CreateBrowserSync(
      window_info, client_, url_text, settings, nullptr, nullptr);
  sync_create_in_flight_ = false;

  if (!browser) {
    *browser_out = 0;
    return Status(IRIS_INITIALIZATION_FAILED);
  }
  *browser_out = pending_id;
  return OkStatus();
}

iris_status_t SessionCore::Command(iris_browser_id_t browser,
                                   const iris_utf8_t& method,
                                   const iris_utf8_t& params_json,
                                   iris_request_id_t* request_out) {
  if (!ready_delivered_) {
    return Status(IRIS_NOT_READY, 0);
  }
  if (!request_out || !Utf8ViewValid(method) || method.len == 0 ||
      !Utf8ViewValid(params_json)) {
    return Status(IRIS_INVALID_ARGUMENT, 0);
  }
  BrowserEntry* entry = FindByPublicId(browser);
  if (!entry) {
    return Status(IRIS_BROWSER_CLOSED, 0);
  }

  // params 必须是 JSON object；空视图等价 "{}"。
  if (!entry->created_delivered || shutdown_requested_) {
    return Status(IRIS_NOT_READY);
  }
  if (entry->closing || entry->native_closed) {
    return Status(IRIS_BROWSER_CLOSED);
  }
  CefRefPtr<CefDictionaryValue> params = CefDictionaryValue::Create();
  if (params_json.len > 0) {
    const std::string params_text = Utf8FromStringView(params_json);
    CefRefPtr<CefValue> parsed = ParseJson(params_text);
    if (!parsed || !(parsed->GetType() == VTYPE_DICTIONARY)) {
      return Status(IRIS_INVALID_ARGUMENT, 0);
    }
    params = parsed->GetDictionary();
  }

  if (request_ids_exhausted_) {
    return Status(IRIS_INVALID_ARGUMENT, 0);  // ID 耗尽：不回绕。
  }
  const uint64_t public_request = next_request_id_++;
  const int native_id = next_native_message_id_;
  request_ids_exhausted_ =
      next_request_id_ == 0 || native_id == std::numeric_limits<int>::max();
  if (native_id != std::numeric_limits<int>::max()) {
    ++next_native_message_id_;
  }

  PendingCommand pending;
  pending.public_request = public_request;
  pending.browser = browser;
  pending.native_message_id = native_id;
  pending_by_native_id_.emplace(native_id, pending);
  try {
    native_by_public_request_.emplace(public_request, native_id);
    // 先取得追踪与超时资源，再执行可能有页面副作用的命令。
    if (!CefPostDelayedTask(TID_UI, new CommandTimeoutTask(this, public_request),
                            kCommandTimeoutMs)) {
      pending_by_native_id_.erase(native_id);
      native_by_public_request_.erase(public_request);
      return Status(IRIS_INITIALIZATION_FAILED);
    }
    const int assigned = entry->browser->GetHost()->ExecuteDevToolsMethod(
        native_id, Utf8FromStringView(method), params);
    if (assigned != native_id) {
      pending_by_native_id_.erase(native_id);
      native_by_public_request_.erase(public_request);
      if (assigned != 0) {
        FailRun(Status(IRIS_INITIALIZATION_FAILED));
      }
      return Status(IRIS_COMMAND_CANCELLED);
    }
  } catch (...) {
    pending_by_native_id_.erase(native_id);
    native_by_public_request_.erase(public_request);
    throw;
  }

  *request_out = public_request;
  return OkStatus();
}

iris_status_t SessionCore::CloseBrowser(iris_browser_id_t browser) {
  if (!ready_delivered_) {
    return Status(IRIS_NOT_READY, 0);
  }
  BrowserEntry* entry = FindByPublicId(browser);
  if (!entry) {
    return Status(IRIS_BROWSER_CLOSED, 0);
  }
  if (!entry->created_delivered) {
    return Status(IRIS_NOT_READY);
  }
  if (entry->native_closed) {
    return Status(IRIS_BROWSER_CLOSED);
  }
  if (!entry->closing && entry->browser) {
    entry->closing = true;
    // 程序化关闭为强制关闭；窗口用户关闭保留常规 beforeunload 交互。
    entry->browser->GetHost()->CloseBrowser(true);
  }
  return OkStatus();
}

iris_status_t SessionCore::RequestShutdown() {
  shutdown_requested_ = true;
  ForceCloseAll();
  ScheduleDrain();  // 无 browser 时由 drain 满足退出条件。
  return OkStatus();
}

// ---- iris_run ----

namespace {

// CefInitialize=false 之后的退出码分类（契约：此时不得调用其他 CEF API）。
iris_status_t ClassifyInitializeFailure(int exit_code) {
  if (exit_code == iris_engine::kInvalidArgumentExit) {
    return Status(IRIS_INVALID_ARGUMENT, exit_code);
  }
  if (exit_code == iris_engine::kProfileUnavailableExit) {
    return Status(IRIS_PROFILE_UNAVAILABLE, exit_code);
  }
  return Status(IRIS_INITIALIZATION_FAILED, exit_code);
}

}  // namespace

void SessionCore::Configure(const iris_config_t& config,
                            iris_event_fn callback,
                            void* user_data) {
  // 配置深拷贝：run 开始后调用方内存不再被引用。
  seed_ = config.seed;
  windowless_ = config.window_mode == IRIS_WINDOW_MODE_WINDOWLESS;
  remote_debugging_port_ = config.remote_debugging_port;
  cache_path_ = WideFromUtf16View(config.cache_path_utf16);
  timezone_ = Utf8FromStringView(config.timezone_utf8);
  callback_ = callback;
  user_data_ = user_data;
}

iris_status_t SessionCore::Run() {
  // 前置顺序：profile 前提 → 引擎符号/build ID → 调试回调注册 → Initialize。
  const auto font_status = CheckProfileFonts();
  if (font_status.code != IRIS_OK) {
    return font_status;
  }

  if (!ResolveEngineExports(remote_debugging_port_ != 0, &engine_)) {
    return Status(IRIS_VERSION_MISMATCH, 0);
  }
  struct DebuggingRegistrationScope {
    EngineExports& engine;
    bool& registered;
    ~DebuggingRegistrationScope() {
      if (registered) {
        engine.set_debugging(nullptr, nullptr);
        registered = false;
      }
    }
  } debugging_scope{engine_, debugging_registered_};

  if (remote_debugging_port_ != 0) {
    engine_.set_debugging(OnEngineDebuggingResult, this);
    debugging_registered_ = true;
  }

  CefSettings settings;
  settings.command_line_args_disabled = true;
  settings.multi_threaded_message_loop = false;
  settings.external_message_pump = false;
  settings.windowless_rendering_enabled = windowless_ ? 1 : 0;
  settings.remote_debugging_port =
      static_cast<int>(remote_debugging_port_);
  CefString(&settings.cache_path).FromWString(cache_path_);
  CefString(&settings.root_cache_path).FromWString(cache_path_);
  CefString(&settings.accept_language_list)
      .FromString(std::string(profile::kAcceptLanguage));
  CefString(&settings.locale).FromString(std::string(profile::kLanguages.front()));

  app_ = new IrisAppImpl(this);
  client_ = new IrisClientImpl(this);

  CefMainArgs main_args(GetBootstrap().instance);
  if (!CefInitialize(main_args, settings, app_, GetBootstrap().sandbox_info)) {
    // 不启动消息循环、不调用 CefShutdown；私有 setter 仅清除回调指针。
    const int exit_code = CefGetExitCode();
    std::fprintf(stderr, "iris: CefInitialize failed: exit=%d\n", exit_code);
    if (debugging_registered_) {
      engine_.set_debugging(nullptr, nullptr);
      debugging_registered_ = false;
    }
    client_ = nullptr;
    app_ = nullptr;
    return ClassifyInitializeFailure(exit_code);
  }

  initialized_ = true;
  ProtectCallback([&] {
    if (run_error_.code != IRIS_OK) {
      FailRun(run_error_);
    } else {
      TryDeliverReady();
    }
    if (!queue_.empty()) {
      ScheduleDrain();
    }
  });
  if (!drain_failed_) {
    loop_running_ = true;
    CefRunMessageLoop();
    loop_running_ = false;
  }
  if (!browsers_.empty() || !pending_popups_.empty() || untracked_closing_count_) {
    // 外部绕过 SDK 强行退出消息循环时，不能对仍存活的 browser 执行 Shutdown。
    std::terminate();
  }

  // ---- 消息循环退出：先停任务，再释放全部 CEF 引用，最后 CefShutdown ----
  shutting_down_ = true;
  if (debugging_registered_ && engine_.set_debugging) {
    // 契约：必须在 CefShutdown 前注销引擎调试回调。
    engine_.set_debugging(nullptr, nullptr);
    debugging_registered_ = false;
  }
  queue_.clear();
  pending_by_native_id_.clear();
  native_by_public_request_.clear();
  for (auto& pair : browsers_) {
    pair.second.devtools_registration = nullptr;
    pair.second.browser = nullptr;
  }
  browsers_.clear();
  public_by_cef_id_.clear();
  client_ = nullptr;
  app_ = nullptr;
  CefShutdown();
  initialized_ = false;

  return run_error_;
}

}  // namespace iris

// ---------------------------------------------------------------------------
// C ABI 导出
// ---------------------------------------------------------------------------

namespace iris {

// 先比较活动指针，且在 UI 线程验证 callback scope 后才能解引用。
iris_status_t ValidateSession(iris_session_t* session) {
  auto& bootstrap = GetBootstrap();
  if (!session || session != bootstrap.active_session.load()) {
    return Status(IRIS_NOT_READY);
  }
  if (::GetCurrentThreadId() != bootstrap.main_thread_id ||
      !bootstrap.active_core || !bootstrap.active_core->InCallback()) {
    return Status(IRIS_NOT_READY, 0);
  }
  return OkStatus();
}

}  // namespace iris

iris_status_t iris_run(const iris_config_t* config,
                       iris_event_fn callback,
                       void* user_data) {
  using namespace iris;  // NOLINT(build/namespaces)
  try {
    BootstrapContext& bootstrap = GetBootstrap();
    if (!bootstrap.in_browser_path.load() ||
        ::GetCurrentThreadId() != bootstrap.main_thread_id) {
      return Status(IRIS_NOT_IN_BOOTSTRAP, 0);
    }
    if (!config || !callback) {
      return Status(IRIS_INVALID_ARGUMENT, 0);
    }
    if (config->struct_size < sizeof(iris_config_t)) {
      return Status(IRIS_INVALID_ARGUMENT, 0);
    }
    if (config->window_mode != IRIS_WINDOW_MODE_WINDOWED &&
        config->window_mode != IRIS_WINDOW_MODE_WINDOWLESS) {
      return Status(IRIS_INVALID_ARGUMENT, 0);
    }
    if (config->remote_debugging_port > 65535) {
      return Status(IRIS_INVALID_ARGUMENT, 0);
    }
    if (!Utf16ViewValid(config->cache_path_utf16) ||
        config->cache_path_utf16.len == 0) {
      return Status(IRIS_INVALID_ARGUMENT, 0);
    }
    if (!std::filesystem::path(WideFromUtf16View(config->cache_path_utf16))
             .is_absolute()) {
      return Status(IRIS_INVALID_ARGUMENT);
    }
    if (!Utf8ViewValid(config->timezone_utf8) ||
        config->timezone_utf8.len > 255) {
      return Status(IRIS_INVALID_ARGUMENT, 0);
    }
    // 参数校验通过后才占用一次性运行标记，允许调用方修正非法配置后重试。
    if (bootstrap.run_started.exchange(true)) {
      return Status(IRIS_ALREADY_RUN, 0);
    }

    SessionCore core;
    core.Configure(*config, callback, user_data);
    return core.Run();
  } catch (...) {
    return Status(IRIS_INITIALIZATION_FAILED, 0);
  }
}

iris_status_t iris_create_browser(iris_session_t* session,
                                  iris_utf8_t url,
                                  iris_browser_id_t* browser_out) {
  using namespace iris;  // NOLINT(build/namespaces)
  try {
    const iris_status_t gate = ValidateSession(session);
    if (gate.code != IRIS_OK) {
      return gate;
    }
    return GetBootstrap().active_core->CreateBrowser(url, browser_out);
  } catch (...) {
    return Status(IRIS_INITIALIZATION_FAILED, 0);
  }
}

iris_status_t iris_command(iris_session_t* session,
                           iris_browser_id_t browser,
                           iris_utf8_t method,
                           iris_utf8_t params_json,
                           iris_request_id_t* request_out) {
  using namespace iris;  // NOLINT(build/namespaces)
  try {
    const iris_status_t gate = ValidateSession(session);
    if (gate.code != IRIS_OK) {
      return gate;
    }
    return GetBootstrap().active_core->Command(browser, method, params_json, request_out);
  } catch (...) {
    return Status(IRIS_INITIALIZATION_FAILED, 0);
  }
}

iris_status_t iris_close_browser(iris_session_t* session,
                                 iris_browser_id_t browser) {
  using namespace iris;  // NOLINT(build/namespaces)
  try {
    const iris_status_t gate = ValidateSession(session);
    if (gate.code != IRIS_OK) {
      return gate;
    }
    return GetBootstrap().active_core->CloseBrowser(browser);
  } catch (...) {
    return Status(IRIS_INITIALIZATION_FAILED, 0);
  }
}

iris_status_t iris_request_shutdown(iris_session_t* session) {
  using namespace iris;  // NOLINT(build/namespaces)
  try {
    const iris_status_t gate = ValidateSession(session);
    if (gate.code != IRIS_OK) {
      return gate;
    }
    return GetBootstrap().active_core->RequestShutdown();
  } catch (...) {
    return Status(IRIS_INITIALIZATION_FAILED, 0);
  }
}
