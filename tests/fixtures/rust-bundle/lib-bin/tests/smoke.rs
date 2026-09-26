mod common;
#[cfg(test)]
mod helpers;

use my_app::run;

#[test]
fn smoke() {
    common::setup();
    run(my_app::cli::parse());
}
