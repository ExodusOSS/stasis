pub mod de;
pub mod parse;

// serde: an explicit path from a crate root, behind another attribute
#[doc(hidden)]
#[path = "private/mod.rs"]
pub mod __private;

#[path = "de/seed.rs"]
mod seed;

// hashbrown: an explicit path inside an inline module
pub mod raw {
    #[allow(missing_docs)]
    #[path = "mod.rs"]
    mod inner;
    pub use inner::*;
}

// platform variants under cfg_attr, with the default file as the fallback
#[cfg_attr(unix, path = "sys/unix.rs")]
#[cfg_attr(windows, path = "sys/windows.rs")]
mod sys;

// a platform-only module whose variant is not on disk: gated, so tolerated
#[cfg(target_os = "fuchsia")]
#[cfg_attr(target_os = "fuchsia", path = "sys/fuchsia.rs")]
mod exotic;

// a cfg_attr that applies a non-cfg attribute gates nothing: the module is unconditional
#[cfg_attr(docsrs, doc(cfg(feature = "de")))]
pub mod documented;
