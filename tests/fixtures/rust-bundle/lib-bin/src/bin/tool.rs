mod helper;

fn main() {
    helper::go();
    my_app::run(my_app::cli::parse());
}
