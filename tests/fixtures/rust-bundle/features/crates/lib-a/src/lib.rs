#[cfg(feature = "std")]
mod std_impl;
#[cfg(not(feature = "std"))]
mod no_std_impl;
#[cfg(feature = "extra")]
pub mod extra;
#[cfg(feature = "serde")]
mod ser;

use winnowish::Parser;

pub fn helper() {
    let _: Option<&dyn Parser> = None;
}
