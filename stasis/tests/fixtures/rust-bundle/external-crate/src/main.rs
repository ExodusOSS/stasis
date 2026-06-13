use std::collections::HashMap;
use serde::Serialize;

mod local;

fn main() {
    let _: HashMap<u8, u8> = HashMap::new();
    local::go();
}
