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

// a cfg_attr variant with no fallback file and no matching variant on disk: tolerated
#[cfg_attr(target_os = "fuchsia", path = "sys/fuchsia.rs")]
mod exotic;
