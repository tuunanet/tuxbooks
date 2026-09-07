#[tokio::main]
async fn main() {
    // The service runs until the client (Electron main) closes stdin.
    std::process::exit(tuxbooks_lib::run().await);
}
