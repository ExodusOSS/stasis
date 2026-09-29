// The package's build script: a crate root of its own, with a module beside it.
#[path = "build/helper.rs"]
mod helper;

fn main() {
    helper::emit();
    println!("cargo:rerun-if-changed=build.rs");
}
