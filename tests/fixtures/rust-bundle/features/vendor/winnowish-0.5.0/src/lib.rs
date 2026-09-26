#[cfg(feature = "unstable-doc")]
pub mod _tutorial;
#[cfg(feature = "std")]
mod std_impl;
#[cfg(feature = "debug")]
mod debug;

pub trait Parser {}
