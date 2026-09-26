#[cfg(feature = "std")]
mod std_impl;
mod detail;

pub fn helper() {
    detail::x();
}
