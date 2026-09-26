use super::server::Server;

pub struct Client;

impl Client {
    pub fn new() -> Self {
        let _ = Server::new();
        Client
    }
}
