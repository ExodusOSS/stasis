mod local;

use tools::Tool;
use util::helper;

fn main() {
    helper();
    local::go();
    let _ = Tool;
}
