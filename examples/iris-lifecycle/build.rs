#[path = "../../crates/iris-sys/sdk_link.rs"]
mod sdk_link;

fn main() {
    sdk_link::configure(true);
}
