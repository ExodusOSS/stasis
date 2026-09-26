pub mod client;
pub mod server;

use self::client::Client;

pub fn both() -> Client {
    Client::new()
}
