mod config;
mod errors;
mod net;
mod util;
#[macro_use] mod macros;
const URL: &str = "https://example.com"; mod after_string;

// a glob in a line comment: handlers/* must not open a block comment
mod a;
/* a nested /* block */ comment with mod ghost; inside */
mod b;

use crate::{config::Config, errors::AppError};
use crate::{
    net::client::Client,
    util::helper as help,
};
use crate::net::server::Server;
pub use crate::a::*;

fn main() {
    let _: Config = Config;
    let _ = help();
    let _ = Client::new();
    let _ = Server::new();
    let _: Result<(), AppError> = Ok(());
    b::go();
    after_string::go();
    m!();
}
