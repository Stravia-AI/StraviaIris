// profile 的字体存在性使用与引擎 broker 相同的 DirectWrite 系统集合。
// 不经 GDI 枚举猜测匹配，不复制字体，也不保存可变的全局查询结果。
#include "iris_internal.h"

#include <algorithm>
#include <array>
#include <cstdio>
#include <dwrite.h>
#include <wrl/client.h>

#include "include/iris_profile_data.h"

namespace iris {

iris_status_t CheckProfileFonts() {
  Microsoft::WRL::ComPtr<IDWriteFactory> factory;
  HRESULT result = DWriteCreateFactory(
      DWRITE_FACTORY_TYPE_SHARED, __uuidof(IDWriteFactory),
      reinterpret_cast<IUnknown**>(factory.GetAddressOf()));
  if (FAILED(result)) {
    return Status(IRIS_PROFILE_UNAVAILABLE, static_cast<int32_t>(result));
  }
  Microsoft::WRL::ComPtr<IDWriteFontCollection> collection;
  result = factory->GetSystemFontCollection(collection.GetAddressOf(), FALSE);
  if (FAILED(result)) {
    return Status(IRIS_PROFILE_UNAVAILABLE, static_cast<int32_t>(result));
  }

  constexpr size_t kFamilyBufferSize = [] {
    size_t size = 1;
    for (const auto family : profile::kFontFamiliesUtf16) {
      size = std::max(size, family.size() + 1);
    }
    return size;
  }();
  std::array<wchar_t, kFamilyBufferSize> name;
  // 可枚举的策略名称不保证存在同名系统字体；启动仅依赖默认渲染字体。
  constexpr std::array required_families{
      profile::kStandardFont, profile::kSerifFont, profile::kSansSerifFont,
      profile::kMonospaceFont, profile::kCursiveFont, profile::kFantasyFont,
      profile::kMathFont};
  for (size_t index = 0; index < profile::kFontFamiliesUtf16.size(); ++index) {
    if (std::find(required_families.begin(), required_families.end(),
                  profile::kFontFamilies[index]) == required_families.end()) {
      continue;
    }
    const auto family = profile::kFontFamiliesUtf16[index];
    *std::copy(family.begin(), family.end(), name.begin()) = L'\0';
    UINT32 family_index = 0;
    BOOL exists = FALSE;
    result = collection->FindFamilyName(name.data(), &family_index, &exists);
    if (FAILED(result) || !exists) {
      const auto label = profile::kFontFamilies[index];
      std::fprintf(stderr, "iris: required font unavailable: %.*s\n",
                   static_cast<int>(label.size()), label.data());
      return Status(IRIS_PROFILE_UNAVAILABLE,
                    FAILED(result) ? static_cast<int32_t>(result) : 0);
    }
  }
  return OkStatus();
}

}  // namespace iris
