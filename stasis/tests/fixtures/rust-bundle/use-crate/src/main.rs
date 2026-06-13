mod foo;
mod bar;

use crate::foo::Greeter;

fn main() {
    let _ = Greeter::new();
    bar::run();
}
