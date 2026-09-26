use crate::config::Config;

pub struct Args;

pub fn parse() -> Args {
    let _ = Config::default();
    Args
}
