use serde::Serialize;

// bitflags-style: a test-only module file that exists on disk
#[cfg(test)]
mod tests;

// an inline test module reaching for a dev-dependency and declaring a nested file
#[cfg(test)]
mod prop {
    use proptest::prelude::*;
    mod strategies;
    #[test]
    fn t() {
        crate::real::go();
    }
}

// a top-level #[test] fn whose body reaches for a dev-dependency
#[test]
fn smoke() {
    quickcheck::quickcheck(real::go as fn());
}

#[cfg(doc)]
mod doc_only;

// `not(test)` always holds in a build: as firm as no cfg at all
#[cfg(not(test))]
mod real;

// undecidable without the feature set: followed when present
#[cfg(any(test, feature = "extra"))]
mod maybe;

// same-name variants under exclusive cfgs merge into one cfg-keyed edge
#[cfg(unix)]
#[path = "sys/unix.rs"]
mod sys;
#[cfg(windows)]
#[path = "sys/windows.rs"]
mod sys;

// a test-only path variant is dropped, the default file stands
#[cfg_attr(test, path = "sys/mock.rs")]
mod backend;

pub fn f() {
    real::go();
    sys::name();
    backend::b();
}
