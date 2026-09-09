/// Die with the client. The JSON-RPC loop already exits on stdin EOF, but a
/// hard-killed Electron main leaves that pipe closed only between reads —
/// PDEATHSIG makes the reaping instant and unconditional. The getppid check
/// closes the arm-after-death race.
#[cfg(unix)]
fn setup_parent_death_signal() {
    const PR_SET_PDEATHSIG: libc::c_int = 1;
    const SIGTERM: libc::c_int = 15;
    let original_ppid = unsafe { libc::getppid() };
    unsafe {
        libc::prctl(PR_SET_PDEATHSIG, SIGTERM, 0, 0, 0);
    }
    if unsafe { libc::getppid() } != original_ppid {
        std::process::exit(0);
    }
}

#[cfg(not(unix))]
fn setup_parent_death_signal() {}

#[tokio::main]
async fn main() {
    setup_parent_death_signal();
    // The service runs until the client (Electron main) closes stdin.
    std::process::exit(tuxbooks_lib::run().await);
}
