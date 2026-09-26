extern crate alpha as a;

use gamma;
use delta::{self, D};

use missing_crate::Nope;

fn main() {
    a::run();
    gamma::g();
    let _: Option<D> = None;
    delta::d();
}
