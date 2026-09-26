pub struct Config {
    #[cfg(feature = "tls")]
    tls: bool,
    pub name: String,
}
pub mod client;

mod imp {
    pub struct Inner {
        #[cfg(feature = "tls")]
        tls: bool
    }
    pub mod server;
}

pub enum Kind {
    A,
    #[cfg(feature = "tls")]
    Secure(u8, u8),
    C,
}
mod after_enum;

pub struct Tuple(#[cfg(feature = "tls")] u8, pub u16);
mod after_tuple;

fn pick(n: u8) -> u8 {
    match n {
        #[cfg(feature = "tls")]
        1 => { 10 }
        _ => 0,
    }
}
mod after_fn;

#[cfg(feature = "tls")]
fn tls_only() { client::connect() }
mod last;
