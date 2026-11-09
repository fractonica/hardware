fn main() {
    println!("cargo:rustc-link-arg-bins=--nmagic");
    println!("cargo:rustc-link-arg-bins=-Tlink.x");
    println!("cargo:rerun-if-env-changed=QONU_BAUD");
    println!("cargo:rerun-if-env-changed=QONU_RTSCTS");
    println!("cargo:rerun-if-env-changed=QONU_LCD_MHZ");
}
