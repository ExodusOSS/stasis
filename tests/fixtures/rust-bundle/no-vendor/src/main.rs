mod a;

use serde::Serialize;
use syn::{parse::Parse, Ident};
use std::collections::HashMap;

fn main() {
    a::go();
    let _: HashMap<u8, u8> = HashMap::new();
}
