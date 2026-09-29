#![doc = include_str!("../README.md")]

#[macro_use]
mod macros;

include!("generated/consts.rs");

pub const TABLE: &str = include_str!("../data/table.txt");
pub const BLOB: &[u8] = include_bytes!("../data/blob.bin");

pub fn go() -> u32 {
    ready!(1) + LIMIT
}

#[cfg(test)]
const TEST_ONLY: &str = include_str!("../data/test-only.txt");

mod gated;
