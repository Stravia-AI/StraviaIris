// 最终 DLL 拥有链接阶段；与 sys crate 共用校验，不能依赖 rlib 转发 link-arg。
#[path = "../../crates/iris-sys/sdk_link.rs"]
mod sdk_link;

fn main() {
    sdk_link::configure(true);
}
