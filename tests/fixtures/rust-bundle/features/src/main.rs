mod util;

#[cfg(feature = "fast")]
mod fast;

#[cfg(feature = "with-serde")]
mod ser;

use lib_a::helper;
use winnowish::Parser;
use winnowish0_5::Parser as OldParser;

fn main() {
    util::u();
    helper();
    let _: Option<&dyn Parser> = None;
    let _: Option<&dyn OldParser> = None;
}
