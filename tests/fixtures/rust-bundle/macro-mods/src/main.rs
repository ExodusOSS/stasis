// cfg_if! re-emits its items, so these are real external modules.
cfg_if::cfg_if! {
    if #[cfg(unix)] {
        mod imp_unix;
        use imp_unix as imp;
    } else {
        mod imp_other;
        use imp_other as imp;
    }
}

// serde_with-style: the macro turns each `mod` into an inline module documented from a .md
// file (`#[doc = include_str!("guide/<name>.md")] pub mod <name> {}`); there is no .rs file.
generate_guide! {
    pub mod guide {
        @code pub mod feature_flags;
        pub mod serde_as;
    }
}

macro_rules! declare {
    ($name:ident) => {
        mod $name;
    };
}
macro_rules! templated {
    () => {
        mod from_template;
    };
}

mod real;

fn main() {
    imp::go();
    real::r();
}
