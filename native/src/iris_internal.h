// StraviaIris 原生 SDK 内部共享声明。不属于公共 ABI；仅本库编译单元使用。
#ifndef STRAVIA_IRIS_IRIS_INTERNAL_H_
#define STRAVIA_IRIS_IRIS_INTERNAL_H_

#include "stravia_iris.h"

#include <windows.h>

#include <atomic>
#include <cstdint>
#include <deque>
#include <map>
#include <optional>
#include <string>
#include <utility>

#include "include/cef_app.h"
#include "include/cef_browser.h"
#include "include/cef_client.h"
#include "include/cef_devtools_message_observer.h"
#include "include/cef_life_span_handler.h"
#include "include/cef_load_handler.h"
#include "include/cef_request_context.h"
#include "include/cef_request_handler.h"
#include "include/cef_version_info.h"

#include "engine_protocol.h"

namespace iris {
class SessionCore;
}

namespace iris {

// ---------------------------------------------------------------------------
// 状态与视图工具
// ---------------------------------------------------------------------------

inline iris_status_t Status(int32_t code, int32_t native_code = 0) {
  iris_status_t s;
  s.code = code;
  s.native_code = native_code;
  return s;
}

inline iris_status_t OkStatus() {
  return Status(IRIS_OK, 0);
}

// 视图契约校验：len==0 允许 null；len>0 要求指针非空且无嵌入 NUL。
bool Utf8ViewValid(const iris_utf8_t& view);
bool Utf16ViewValid(const iris_utf16_t& view);

std::string Utf8FromStringView(const iris_utf8_t& view);  // 已校验后使用
std::wstring WideFromUtf16View(const iris_utf16_t& view);

// JSON payload 组装（经 CefDictionaryValue/CefWriteJSON，正确转义）。
std::string EmptyPayload();  // "{}"
std::string LoadErrorPayload(int32_t code,
                             const std::string& message,
                             const std::string& url);
std::string RendererTerminatedPayload(int32_t status, int32_t error_code);
// method + 原始 params JSON（可为空）→ {"method":...,"params":{...}}。
std::string ProtocolEventPayload(const std::string& method,
                                 const std::string& params_json);
// CEF 命令结果缓冲归一化：空缓冲归一为 "{}"，其余原样透传。
std::string NormalizeResultPayload(const void* result, size_t result_size);

// ---------------------------------------------------------------------------
// bootstrap 上下文（进程唯一）
// ---------------------------------------------------------------------------

struct BootstrapContext {
  // iris_bootstrap_main 已进入（子进程与 browser 进程共用该入口）。
  std::atomic<bool> entered{false};
  // 当前处于 browser 进程路径（application_main 生命周期内有效）。
  std::atomic<bool> in_browser_path{false};
  // iris_run 已开始（进程内只允许一次运行）。
  std::atomic<bool> run_started{false};
  std::atomic<iris_session_t*> active_session{nullptr};
  SessionCore* active_core = nullptr;  // 仅 UI 线程在当前 callback scope 内读取

  DWORD main_thread_id = 0;
  HINSTANCE instance = nullptr;  // CefMainArgs 使用的主模块句柄
  void* sandbox_info = nullptr;  // 借用自 bootstrap 栈帧，仅 browser 路径内有效
  cef_version_info_t version_info{};  // bootstrap 提供版本的深拷贝
};

BootstrapContext& GetBootstrap();

// 编译头与 libcef 运行库的一致性检查（API hash/版本/沙箱兼容哈希）。
// 返回 false 时 *out_status 携带 IRIS_VERSION_MISMATCH。
bool CheckRuntimeVersions(iris_status_t* out_status);

// ---------------------------------------------------------------------------
// 引擎私有协议（libcef 补丁导出）
// ---------------------------------------------------------------------------

struct EngineExports {
  iris_engine::BuildIdFunction build_id = nullptr;
  iris_engine::SetDebuggingCallbackFunction set_debugging = nullptr;
};

// 解析 libcef 的 iris_engine_* 导出并校验 build ID：
//   - 缺失导出（原版基线）或 build ID 非法/与 IRIS_ENGINE_BUILD_ID 不一致
//     → IRIS_VERSION_MISMATCH；
//   - set_debugging 仅在需要调试端口时必需。
bool ResolveEngineExports(bool require_debugging, EngineExports* out);

// 引擎调试端点回调在 UI 线程到达；直接转发给 SessionCore。
void OnEngineDebuggingResult(int32_t status,
                             int32_t native_error,
                             uint32_t port,
                             void* user_data);

// ---------------------------------------------------------------------------
// profile 前置条件（数据来自 CEF_ROOT/include/iris_profile_data.h）
// ---------------------------------------------------------------------------

// 逐 family 查询真实 DirectWrite 集合；失败保留 HRESULT。
iris_status_t CheckProfileFonts();

// ---------------------------------------------------------------------------
// 会话核心
// ---------------------------------------------------------------------------

class SessionCore;
class IrisClientImpl;
using PopupKey = std::pair<int, int>;  // opener CEF ID + CEF popup ID

struct QueuedEvent {
  uint32_t kind = 0;
  iris_browser_id_t browser = 0;
  iris_request_id_t request = 0;
  iris_status_t status{IRIS_OK, 0};
  std::string payload;  // NUL 结尾，事件视图借用至回调返回
};

struct BrowserEntry {
  uint64_t public_id = 0;
  int cef_id = 0;
  bool closing = false;
  bool native_closed = false;
  bool created_delivered = false;
  CefRefPtr<CefBrowser> browser;
  CefRefPtr<CefRegistration> devtools_registration;
};

struct PendingCommand {
  uint64_t public_request = 0;
  iris_browser_id_t browser = 0;
  int native_message_id = 0;
};

// UI 线程任务：事件 drain（串行、禁止重入）。
class DrainTask;
// UI 线程延迟任务：命令 30 秒超时。
class CommandTimeoutTask;

// 30 秒命令超时（毫秒）。
constexpr int64_t kCommandTimeoutMs = 30000;

class SessionCore {
 public:
  SessionCore();
  ~SessionCore();
  SessionCore(const SessionCore&) = delete;
  SessionCore& operator=(const SessionCore&) = delete;

  // ---- iris_run 阶段 ----
  // 配置深拷贝与初始化（视图已通过 iris_run 校验）。
  void Configure(const iris_config_t& config, iris_event_fn callback, void* user_data);
  iris_status_t Run();  // 阻塞至消息循环退出

  // ---- 会话 API（均要求 UI 线程 + 会话有效）----
  iris_status_t CreateBrowser(const iris_utf8_t& url,
                              iris_browser_id_t* browser_out);
  iris_status_t Command(iris_browser_id_t browser,
                        const iris_utf8_t& method,
                        const iris_utf8_t& params_json,
                        iris_request_id_t* request_out);
  iris_status_t CloseBrowser(iris_browser_id_t browser);
  iris_status_t RequestShutdown();

  bool OnSessionThread() const;
  bool InCallback() const { return callback_active_ && !shutting_down_; }

  template <typename Function>
  void ProtectCallback(Function&& function) noexcept {
    try {
      std::forward<Function>(function)();
    } catch (...) {
      CallbackFailed();
    }
  }

  // ---- 引擎调试回调（UI 线程，可能在 CefInitialize 期间到达）----
  void OnDebuggingResult(int32_t status, int32_t native_error, uint32_t port);

 private:
  friend class DrainTask;
  friend class CommandTimeoutTask;
  friend void OnEngineDebuggingResult(int32_t, int32_t, uint32_t, void*);

  // CefApp/CefClient 回调（均在 UI 线程）。
  friend class IrisAppImpl;
  friend class IrisClientImpl;
  void OnBeforeCommandLineProcessing(const CefString& process_type,
                                     CefRefPtr<CefCommandLine> command_line);
  void OnContextInitialized();
  void OnAfterCreated(CefRefPtr<CefBrowser> browser,
                      const std::optional<PopupKey>& popup);
  bool OnBeforePopup(PopupKey popup);
  void OnBeforePopupAborted(PopupKey popup);
  void OnBeforeClose(CefRefPtr<CefBrowser> browser);
  void OnLoadError(CefRefPtr<CefBrowser> browser,
                   CefRefPtr<CefFrame> frame,
                   int32_t code,
                   const CefString& message,
                   const CefString& url);
  void OnRenderProcessTerminated(CefRefPtr<CefBrowser> browser,
                                 int32_t status,
                                 int32_t error_code);
  void OnDevToolsMethodResult(CefRefPtr<CefBrowser> browser,
                              int message_id,
                              bool success,
                              const void* result,
                              size_t result_size);
  void OnDevToolsEvent(CefRefPtr<CefBrowser> browser,
                       const CefString& method,
                       const void* params,
                       size_t params_size);
  void OnDevToolsAgentDetached(CefRefPtr<CefBrowser> browser);

  // 事件与 drain。
  void QueueEvent(uint32_t kind,
                  iris_browser_id_t browser,
                  iris_request_id_t request,
                  iris_status_t status,
                  std::string payload);
  void ScheduleDrain();
  void RunDrain();      // DrainTask 入口；串行调用宿主回调
  void MaybeQuit();     // 满足退出条件时 CefQuitMessageLoop

  // Ready 前置条件汇聚。
  void TryDeliverReady();
  // 记录运行失败错误并请求关闭（无 browser 时立即退出）。
  void FailRun(iris_status_t status);
  void CallbackFailed() noexcept;
  uint64_t AllocateBrowserId();

  // 取消某 browser 全部待定命令，逐个投递 CommandResult。
  void CancelPendingForBrowser(iris_browser_id_t browser, int32_t code);
  void OnCommandTimeout(uint64_t public_request);  // 延迟任务入口
  void ForceCloseAll();

  BrowserEntry* FindByCefId(int cef_id);
  BrowserEntry* FindByPublicId(iris_browser_id_t public_id);
  void HandleCallbackResult(uint32_t result);

  // ---- 配置拷贝（iris_run 开始时固定）----
  uint64_t seed_ = 0;
  bool windowless_ = false;
  uint32_t remote_debugging_port_ = 0;
  std::wstring cache_path_;
  std::string timezone_;  // 空 = 跟随宿主

  iris_event_fn callback_ = nullptr;
  void* user_data_ = nullptr;

  // Ready 前置状态。
  bool context_initialized_ = false;
  bool preference_verified_ = false;
  bool ready_delivered_ = false;
  bool debugging_result_arrived_ = false;
  int32_t debugging_status_ = 0;
  int32_t debugging_native_error_ = 0;
  uint32_t debugging_port_ = 0;

  // 运行状态。
  bool shutdown_requested_ = false;
  bool initialized_ = false;
  bool loop_running_ = false;
  bool drain_failed_ = false;
  bool draining_ = false;
  bool callback_active_ = false;
  bool ever_created_ = false;  // 曾交付过 BrowserCreated
  bool shutting_down_ = false;  // 消息循环退出后的任务防护
  iris_status_t run_error_{IRIS_OK, 0};

  // ID 分配（单调不复用；耗尽即报错，不回绕）。
  uint64_t next_browser_id_ = 1;
  uint64_t next_request_id_ = 1;
  int next_native_message_id_ = 1;
  bool browser_ids_exhausted_ = false;
  bool request_ids_exhausted_ = false;
  uintptr_t next_callback_token_ = 1;

  // 同步创建配对（CreateBrowserSync 内同步触发 OnAfterCreated）。
  bool sync_create_in_flight_ = false;
  uint64_t sync_create_pending_id_ = 0;

  // 每个 popup 的 client 携带此 key，避免并发创建完成顺序改变时配错 ID。
  std::map<PopupKey, iris_browser_id_t> pending_popups_;
  size_t untracked_closing_count_ = 0;

  std::map<iris_browser_id_t, BrowserEntry> browsers_;
  std::map<int, iris_browser_id_t> public_by_cef_id_;
  std::map<int, PendingCommand> pending_by_native_id_;
  std::map<iris_request_id_t, int> native_by_public_request_;
  std::deque<QueuedEvent> queue_;
  bool drain_posted_ = false;

  EngineExports engine_;
  bool debugging_registered_ = false;

  CefRefPtr<CefApp> app_;
  CefRefPtr<IrisClientImpl> client_;

};

}  // namespace iris

#endif  // STRAVIA_IRIS_IRIS_INTERNAL_H_
