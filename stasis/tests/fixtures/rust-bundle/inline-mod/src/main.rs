mod inline {
    pub fn x() {}
}

mod real;

fn main() {
    inline::x();
    real::y();
}
