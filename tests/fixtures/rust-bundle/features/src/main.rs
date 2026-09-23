mod util;

#[cfg(feature = "fast")]
mod fast;

#[cfg(feature = "with-serde")]
mod ser;

use lib_a::helper;
use winnowish::Parser;

fn main() {
    util::u();
    helper();
    let _: Option<&dyn Parser> = None;
}
