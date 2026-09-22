mod outer {
    pub mod inner;

    pub mod deep {
        pub mod leaf;
    }

    #[cfg(feature = "testing")]
    mod tests {
        use super::inner::go;
        mod fixtures;
    }
}

use outer::inner::go;

fn main() {
    go();
    outer::deep::leaf::x();
}
