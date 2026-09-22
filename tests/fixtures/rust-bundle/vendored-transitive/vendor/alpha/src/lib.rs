mod inner;

use beta_lib::b;

pub fn run() {
    inner::x();
    b();
    crate::inner::x();
}
