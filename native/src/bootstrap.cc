// iris_bootstrap_main：bootstrapc.exe + 客户端 DLL 的标准入口实现。
//
// 调用顺序（与上游 bootstrap 架构一致，见 cef/docs/sandbox_setup.md）：
//   1. 一次性/参数/线程校验；
//   2. 编译头 ↔ libcef 运行库 ↔ bootstrap 携带版本信息三方一致性检查；
//   3. CefExecuteProcess——子进程直接返回退出码；
//   4. browser 路径保存主线程 scoped 上下文后调用 application_main。
//
// 禁止从 DllMain 调用；本文件不做任何 CEF 全局初始化之外的隐藏动作。

#include "iris_internal.h"

#include <cstdio>
#include <cstring>

#include "include/cef_api_hash.h"
#include "include/cef_command_line.h"
#include "include/cef_version.h"

#include "iris_build_id.h"

namespace iris {

BootstrapContext& GetBootstrap() {
  static BootstrapContext context;
  return context;
}

namespace {

bool StringsEqual(const char* a, const char* b) {
  if (!a || !b) {
    return false;
  }
  return std::strcmp(a, b) == 0;
}

bool IsLowercaseHex64(const char* s) {
  if (!s) {
    return false;
  }
  for (int i = 0; i < 64; ++i) {
    const char c = s[i];
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) {
      return false;
    }
  }
  return s[64] == '\0';
}

}  // namespace

bool CheckRuntimeVersions(iris_status_t* out_status) {
  *out_status = Status(IRIS_OK, 0);

  // 1) 编译头 API hash ↔ libcef 运行库（入口 0 = 平台 hash）。
  const char* runtime_platform_hash =
      cef_api_hash(CEF_API_VERSION, 0 /* CEF_API_HASH_PLATFORM */);
  if (!StringsEqual(runtime_platform_hash, CEF_API_HASH_PLATFORM)) {
    *out_status = Status(IRIS_VERSION_MISMATCH, 0);
    return false;
  }

  // 2) 沙箱兼容哈希（Windows，入口 3）。
  const char* runtime_sandbox_hash =
      cef_api_hash(CEF_API_VERSION, 3 /* CEF_SANDBOX_COMPAT_HASH */);
  if (!StringsEqual(runtime_sandbox_hash, CEF_SANDBOX_COMPAT_HASH)) {
    *out_status = Status(IRIS_VERSION_MISMATCH, 0);
    return false;
  }

  // 3) bootstrap 携带的版本信息 ↔ libcef 实际版本。
  cef_version_info_t runtime{};
  runtime.size = sizeof(runtime);
  cef_version_info_all(&runtime);
  const cef_version_info_t& expected = GetBootstrap().version_info;
  if (runtime.cef_version_major != expected.cef_version_major ||
      runtime.cef_version_minor != expected.cef_version_minor ||
      runtime.cef_version_patch != expected.cef_version_patch ||
      runtime.cef_commit_number != expected.cef_commit_number ||
      runtime.chrome_version_major != expected.chrome_version_major ||
      runtime.chrome_version_minor != expected.chrome_version_minor ||
      runtime.chrome_version_build != expected.chrome_version_build ||
      runtime.chrome_version_patch != expected.chrome_version_patch) {
    *out_status = Status(IRIS_VERSION_MISMATCH, 0);
    return false;
  }
  if (std::strncmp(runtime.sandbox_compat_hash, expected.sandbox_compat_hash,
                   sizeof(runtime.sandbox_compat_hash)) != 0) {
    *out_status = Status(IRIS_VERSION_MISMATCH, 0);
    return false;
  }

  // 4) libcef 运行库 ↔ 本库编译头（bootstrap 与 SDK 由同一分发头文件编译）。
  if (runtime.cef_version_major != CEF_VERSION_MAJOR ||
      runtime.cef_version_minor != CEF_VERSION_MINOR ||
      runtime.cef_version_patch != CEF_VERSION_PATCH ||
      runtime.chrome_version_major != CHROME_VERSION_MAJOR ||
      runtime.chrome_version_minor != CHROME_VERSION_MINOR ||
      runtime.chrome_version_build != CHROME_VERSION_BUILD ||
      runtime.chrome_version_patch != CHROME_VERSION_PATCH) {
    *out_status = Status(IRIS_VERSION_MISMATCH, 0);
    return false;
  }

  return true;
}

bool ResolveEngineExports(bool require_debugging, EngineExports* out) {
  *out = EngineExports{};
  // 本库静态导入 libcef.dll，任何 SDK 函数执行时模块必已加载。
  HMODULE libcef = ::GetModuleHandleW(L"libcef");
  if (!libcef) {
    return false;
  }
  out->build_id = reinterpret_cast<iris_engine::BuildIdFunction>(
      reinterpret_cast<void*>(::GetProcAddress(
          libcef, iris_engine::kBuildIdSymbol)));
  if (!out->build_id) {
    return false;  // 原版基线：无引擎导出。
  }
  const char* build_id = out->build_id();
  if (!IsLowercaseHex64(build_id)) {
    return false;
  }
  if (std::strncmp(build_id, IRIS_ENGINE_BUILD_ID, 64) != 0) {
    return false;  // 引擎 build ID 与 SDK 编译期绑定值不一致。
  }
  if (require_debugging) {
    out->set_debugging =
        reinterpret_cast<iris_engine::SetDebuggingCallbackFunction>(
            reinterpret_cast<void*>(::GetProcAddress(
                libcef, iris_engine::kDebuggingCallbackSymbol)));
    if (!out->set_debugging) {
      return false;
    }
  }
  return true;
}

}  // namespace iris

int32_t iris_bootstrap_main(int argc,
                            char** argv,
                            void* sandbox_info,
                            const void* version_info,
                            int32_t (*application_main)(void*),
                            void* user_data) {
  using namespace iris;  // NOLINT(build/namespaces)

  // C++ 异常不得穿越 C ABI。
  try {
    BootstrapContext& bootstrap = GetBootstrap();
    if (!application_main || !sandbox_info || !version_info ||
        argc < 0 || (argc > 0 && !argv)) {
      return IRIS_INVALID_ARGUMENT;
    }

    // SDK 与 bootstrap 固定同一分发，拒绝不匹配的结构布局，避免越界复制。
    const cef_version_info_t* info =
        static_cast<const cef_version_info_t*>(version_info);
    if (info->size != sizeof(cef_version_info_t)) {
      return IRIS_INVALID_ARGUMENT;
    }
    if (bootstrap.entered.exchange(true)) {
      return IRIS_ALREADY_RUN;
    }

    bootstrap.main_thread_id = ::GetCurrentThreadId();
    bootstrap.instance = ::GetModuleHandleW(nullptr);
    bootstrap.version_info = *info;

    // 在执行任何 CEF 流程前完成版本一致性检查（失败时直接返回状态码，
    // 不进入 CefExecuteProcess 的 api-hash 崩溃路径）。
    iris_status_t version_status;
    if (!CheckRuntimeVersions(&version_status)) {
      return version_status.code;
    }
    EngineExports engine;
    if (!ResolveEngineExports(false, &engine)) {
      return IRIS_VERSION_MISMATCH;
    }

    // 子进程在此返回；只有 browser 进程继续。
    CefMainArgs main_args(bootstrap.instance);
    const int execute_result =
        CefExecuteProcess(main_args, CefRefPtr<CefApp>(), sandbox_info);
    if (execute_result >= 0) {
      return execute_result;
    }

    struct BrowserPathScope {
      BootstrapContext& context;
      ~BrowserPathScope() {
        context.in_browser_path.store(false);
        context.sandbox_info = nullptr;
      }
    } scope{bootstrap};
    bootstrap.sandbox_info = sandbox_info;
    bootstrap.in_browser_path.store(true);
    return application_main(user_data);
  } catch (...) {
    // 意外异常（理论上仅 bad_alloc）按内部失败上报，绝不穿越 C ABI。
    return IRIS_INITIALIZATION_FAILED;
  }
}
