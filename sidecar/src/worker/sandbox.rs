//! The worker's own OS containment (ADR 0001 D3, W-2..W-5, W-10, W-11).
//! Three dependency-free layers applied by the worker itself, then proven:
//! Landlock (all filesystem access denied; filesystem only), a seccomp
//! classic-BPF deny-list (exec/spawn/namespaces/debug syscalls, plus socket
//! creation unconditionally: TCP, UDP, AF_UNIX, and netlink in one rule),
//! and rlimits. Self-verification closes the loop: if the probes do not
//! observe the claimed denials, the job fails with a typed sandbox error.
//! Nothing here is root-required or display-dependent; all of it is
//! testable headless in CI. Landlock is thread-scoped; seccomp is
//! process-wide, which is why tests exercise seccomp only in forked
//! children, with the program built before the fork.

use std::fs::File;

use crate::limits::ResourceLimits;
use crate::worker::proto::LandlockStatus;

/// Address-space ceiling for one job (W-8): headroom over the 2 GiB
/// total-uncompressed quota plus parser and PDFium working set. Embed
/// sources are additionally capped at `MAX_EMBED_SOURCE_BYTES` so the
/// source, the rewritten document, and the base64 output fit together.
pub const WORKER_ADDRESS_SPACE_CAP: u64 = 3 << 30;

/// The pure fail-closed decision: Linux parses nothing without Landlock.
pub fn check(status: &LandlockStatus) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        match status {
            LandlockStatus::Unsupported => Err(
                "Landlock is unavailable on this kernel; refusing to parse without the sandbox layer"
                    .to_string(),
            ),
            _ => Ok(()),
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = status;
        Ok(())
    }
}

pub fn prepare(limits: &ResourceLimits) -> Result<SandboxReport, String> {
    let status = if cfg!(target_os = "linux") {
        landlock_abi()
    } else {
        LandlockStatus::NotApplicable
    };
    check(&status)?;
    // 1. PR_SET_NO_NEW_PRIVS: required by Landlock's restrict_self and by
    //    seccomp; also prevents privilege escalation through exec.
    set_no_new_privs()?;
    // 2. Landlock deny-all: every handled FS access is denied because the
    //    ruleset carries zero rules. Filesystem only; the network is
    //    seccomp's job (see below).
    let landlock = if cfg!(target_os = "linux") {
        apply_landlock_deny_all().map_err(|err| format!("landlock: {err}"))?
    } else {
        LandlockStatus::NotApplicable
    };
    // 3. seccomp deny-list: exec/spawn/namespaces/debug syscalls, and
    //    socket creation unconditionally (owns W-3 on every kernel).
    let seccomp_applied = install_seccomp()?;
    // 4. rlimits: CPU, address space, no file writes (Linux; the report
    //    records honestly what applied on each platform).
    let rlimits_applied = apply_rlimits(limits)?;
    // 5. self-verification: the probes must observe the claimed denials.
    let report = SandboxReport {
        landlock,
        seccomp_applied,
        rlimits_applied,
        verified: false,
    };
    self_verify(&report)?;
    Ok(SandboxReport {
        verified: true,
        ..report
    })
}

/// Per-layer status of one applied sandbox, recorded for logs and the
/// SelfTest report.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SandboxReport {
    pub landlock: LandlockStatus,
    pub seccomp_applied: bool,
    pub rlimits_applied: bool,
    pub verified: bool,
}

pub fn landlock_abi() -> LandlockStatus {
    #[cfg(target_os = "linux")]
    {
        match probe_landlock_abi() {
            Some(abi) => LandlockStatus::Applied { abi },
            None => LandlockStatus::Unsupported,
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        LandlockStatus::NotApplicable
    }
}

pub fn landlock_supported() -> bool {
    #[cfg(target_os = "linux")]
    {
        !matches!(landlock_abi(), LandlockStatus::Unsupported)
    }
    #[cfg(not(target_os = "linux"))]
    {
        // No Landlock off Linux: kernel-gated tests must skip, not claim a
        // sandbox that does not exist.
        false
    }
}

pub fn probe_socket_denied() -> bool {
    #[cfg(target_os = "linux")]
    {
        let fd = unsafe { libc::socket(libc::AF_INET, libc::SOCK_STREAM, 0) };
        if fd == -1 {
            return unsafe { *libc::__errno_location() } == libc::EPERM;
        }
        unsafe { libc::close(fd) };
        false
    }
    #[cfg(not(target_os = "linux"))]
    {
        // No sandbox layer claims network denial off Linux.
        false
    }
}

pub fn self_verify(report: &SandboxReport) -> Result<(), String> {
    if matches!(report.landlock, LandlockStatus::Applied { .. })
        && File::open("/proc/self/status").is_ok()
    {
        return Err("self-verification failed: filesystem denial not in effect".to_string());
    }
    // C3: socket denial is claimed whenever seccomp applied (always on
    // Linux), so the probe must observe it unconditionally. There is no
    // ABI-4 branch left to disagree with the layering.
    if report.seccomp_applied && !probe_socket_denied() {
        return Err("self-verification failed: network denial not in effect".to_string());
    }
    Ok(())
}

pub fn apply_rlimits(limits: &ResourceLimits) -> Result<bool, String> {
    #[cfg(target_os = "linux")]
    {
        use libc::{rlimit, setrlimit, RLIMIT_AS, RLIMIT_CPU, RLIMIT_FSIZE};
        let set = |resource: libc::__rlimit_resource_t, cur: u64, max: u64| {
            let value = rlimit {
                rlim_cur: cur,
                rlim_max: max,
            };
            let rc = unsafe { setrlimit(resource, &value) };
            if rc == -1 {
                Err(format!(
                    "setrlimit({resource}) failed: {}",
                    std::io::Error::last_os_error()
                ))
            } else {
                Ok(())
            }
        };
        let cpu = limits.max_parse_seconds;
        set(RLIMIT_CPU, cpu, cpu.saturating_add(5))?;
        set(
            RLIMIT_AS,
            WORKER_ADDRESS_SPACE_CAP,
            WORKER_ADDRESS_SPACE_CAP,
        )?;
        set(RLIMIT_FSIZE, 0, 0)?;
        Ok(true)
    }
    #[cfg(not(target_os = "linux"))]
    {
        // No rlimit enforcement off Linux; the report says so.
        let _ = limits;
        Ok(false)
    }
}

fn set_no_new_privs() -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        const PR_SET_NO_NEW_PRIVS: libc::c_int = 38;
        let rc = unsafe { libc::prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) };
        if rc == -1 {
            Err(format!(
                "PR_SET_NO_NEW_PRIVS: {}",
                std::io::Error::last_os_error()
            ))
        } else {
            Ok(())
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        // prctl does not exist off Linux; nothing to set there.
        Ok(())
    }
}

// ---- Landlock FFI (linux/landlock.h) ---------------------------------------
//
// ABI probe: landlock_create_ruleset(NULL, 0, LANDLOCK_CREATE_RULESET_VERSION)
// returns the ABI version, or -1 with EOPNOTSUPP/EINVAL on pre-5.13 kernels.
// Apply: create a ruleset whose handled_access_fs carries the FS bits the
// probed ABI supports, add ZERO rules, then
// landlock_restrict_self(ruleset_fd, 0): every handled access is denied.
// C2: the ruleset attribute is the fs-only 8-byte struct the UAPI has had
// since 5.13 on every supported kernel. The 16-byte struct with
// handled_access_net (6.7+) is deliberately not used: pre-6.7 kernels
// reject larger attribute sizes with E2BIG, and the network is seccomp's
// job anyway. Syscall numbers come from libc's SYS_landlock_* constants.

#[cfg(target_os = "linux")]
mod landlock_ffi {
    // repr(C) mirror of the UAPI struct (libc does not ship landlock.h).
    // fs-only: exactly one u64, so no attr-size negotiation can ever occur.
    #[repr(C)]
    pub struct LandlockRulesetAttr {
        pub handled_access_fs: u64,
    }

    // LANDLOCK_ACCESS_FS bits (UAPI, stable): EXECUTE(0), WRITE_FILE(1),
    // READ_FILE(2), READ_DIR(3), REMOVE_DIR(4), REMOVE_FILE(5), MAKE_CHAR(6),
    // MAKE_DIR(7), MAKE_REG(8), MAKE_SOCK(9), MAKE_FIFO(10), MAKE_BLOCK(11),
    // MAKE_SYM(12); ABI 2 adds REFER(13); ABI 3 adds TRUNCATE(14); ABI 5
    // adds IOCTL_DEV(15). Handled bits are chosen from the probed ABI so an
    // older kernel never handles an access bit it cannot enforce.
    pub fn fs_bits(abi: u32) -> u64 {
        let mut bits = 0x1FFFu64; // EXECUTE .. MAKE_SYM (bits 0..12)
        if abi >= 2 {
            bits |= 1 << 13; // REFER
        }
        if abi >= 3 {
            bits |= 1 << 14; // TRUNCATE
        }
        if abi >= 5 {
            bits |= 1 << 15; // IOCTL_DEV
        }
        bits
    }

    pub const CREATE_RULESET_VERSION: u32 = 1 << 0;

    pub fn probe_abi() -> Option<u32> {
        let rc = unsafe {
            libc::syscall(
                libc::SYS_landlock_create_ruleset,
                std::ptr::null::<libc::c_void>(),
                0,
                CREATE_RULESET_VERSION,
            )
        };
        if rc < 0 {
            None
        } else {
            Some(rc as u32)
        }
    }

    pub fn restrict_all(abi: u32) -> Result<(), String> {
        let attr = LandlockRulesetAttr {
            handled_access_fs: fs_bits(abi),
        };
        let fd = unsafe {
            libc::syscall(
                libc::SYS_landlock_create_ruleset,
                &attr as *const LandlockRulesetAttr,
                std::mem::size_of::<LandlockRulesetAttr>(),
                0u32,
            )
        };
        if fd < 0 {
            return Err(format!(
                "create_ruleset: {}",
                std::io::Error::last_os_error()
            ));
        }
        let rc = unsafe { libc::syscall(libc::SYS_landlock_restrict_self, fd as i32, 0u32) };
        // The ruleset fd is consumed by restrict_self; close it either way.
        unsafe { libc::close(fd as i32) };
        if rc < 0 {
            Err(format!(
                "restrict_self: {}",
                std::io::Error::last_os_error()
            ))
        } else {
            Ok(())
        }
    }
}

#[cfg(target_os = "linux")]
fn probe_landlock_abi() -> Option<u32> {
    landlock_ffi::probe_abi()
}

#[cfg(target_os = "linux")]
fn apply_landlock_deny_all() -> Result<LandlockStatus, String> {
    let status = landlock_abi();
    if let LandlockStatus::Applied { abi } = status {
        landlock_ffi::restrict_all(abi)?;
    }
    Ok(status)
}

#[cfg(not(target_os = "linux"))]
fn apply_landlock_deny_all() -> Result<LandlockStatus, String> {
    Ok(LandlockStatus::NotApplicable)
}

// ---- seccomp classic BPF ----------------------------------------------------
//
// Program shape: load the arch word, deny everything on a foreign arch, load
// the syscall number, one compare-and-deny pair per denied syscall (with the
// clone flag check inlined for clone), then RET_ALLOW. Jump offsets are
// computed so the arithmetic cannot drift: each JEQ uses jt=0 so the true
// path falls through to the immediately following RET EPERM and jf skips
// exactly that one instruction; the arch check inverts this (jt=1 skips the
// RET EPERM on match); the clone block's first JEQ uses jf=3 to skip the
// three instructions of the flag check.
// Building the program (a plain Vec) and installing it (a syscall) are split
// (M2): the forked test child must not allocate, so it receives a program
// built before the fork.

#[cfg(target_os = "linux")]
mod seccomp_ffi {
    /// repr(C) mirror of the UAPI `sock_filter` (libc does not ship it).
    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct sock_filter {
        pub code: u16,
        pub jt: u8,
        pub jf: u8,
        pub k: u32,
    }

    #[repr(C)]
    pub struct sock_fprog {
        pub len: u16,
        pub filter: *const sock_filter,
    }

    pub const BPF_LD: u16 = 0x00;
    pub const BPF_W: u16 = 0x00;
    pub const BPF_ABS: u16 = 0x20;
    pub const BPF_JMP: u16 = 0x05;
    pub const BPF_JEQ: u16 = 0x10;
    pub const BPF_JSET: u16 = 0x40;
    pub const BPF_RET: u16 = 0x06;
    pub const BPF_K: u16 = 0x00;
    // seccomp_data layout (UAPI, stable): nr(0), arch(4), ip(8), args[0](16).
    pub const OFFSET_NR: u32 = 0;
    pub const OFFSET_ARCH: u32 = 4;
    pub const OFFSET_ARG0: u32 = 16;
    pub const SECCOMP_RET_ALLOW: u32 = 0x7fff_0000;
    pub const SECCOMP_RET_ERRNO: u32 = 0x0005_0000;
    pub const EPERM: u32 = 1;
    pub const ENOSYS: u32 = 38;
    pub const SECCOMP_SET_MODE_FILTER: u32 = 1;
}

#[cfg(target_os = "linux")]
fn install_seccomp() -> Result<bool, String> {
    let program = build_seccomp_program();
    install_seccomp_program(&program)?;
    Ok(true)
}

#[cfg(not(target_os = "linux"))]
fn install_seccomp() -> Result<bool, String> {
    Ok(false)
}

#[cfg(target_os = "linux")]
fn build_seccomp_program() -> Vec<seccomp_ffi::sock_filter> {
    use seccomp_ffi::*;

    let instr = |code: u16, jt: u8, jf: u8, k: u32| sock_filter { code, jt, jf, k };
    let load = |offset: u32| instr(BPF_LD | BPF_W | BPF_ABS, 0, 0, offset);
    let ret = |value: u32| instr(BPF_RET | BPF_K, 0, 0, value);
    let ret_eperm = ret(SECCOMP_RET_ERRNO | EPERM);
    let ret_enosys = ret(SECCOMP_RET_ERRNO | ENOSYS);
    let ret_allow = ret(SECCOMP_RET_ALLOW);
    let audit_arch: u32 = if cfg!(target_arch = "aarch64") {
        0xC000_00B7
    } else {
        0xC000_003E
    };

    let mut denied = vec![
        libc::SYS_execve,
        libc::SYS_execveat,
        libc::SYS_unshare,
        libc::SYS_setns,
        libc::SYS_mount,
        libc::SYS_umount2,
        libc::SYS_ptrace,
        libc::SYS_bpf,
        libc::SYS_keyctl,
        libc::SYS_kexec_load,
        libc::SYS_kexec_file_load,
        libc::SYS_open_by_handle_at,
        libc::SYS_name_to_handle_at,
        libc::SYS_reboot,
        libc::SYS_swapon,
        libc::SYS_swapoff,
        libc::SYS_init_module,
        libc::SYS_finit_module,
        libc::SYS_delete_module,
    ];
    // x86_64 only: aarch64 has no fork/vfork syscalls (glibc emulates
    // them through clone), so those two constants do not exist there.
    if cfg!(target_arch = "x86_64") {
        denied.push(libc::SYS_fork);
        denied.push(libc::SYS_vfork);
    }
    // CLONE_NEWNS | CLONE_NEWUSER | CLONE_NEWNET | CLONE_NEWPID |
    // CLONE_NEWIPC | CLONE_NEWUTS
    const NS_FLAGS: u64 =
        0x0002_0000 | 0x1000_0000 | 0x4000_0000 | 0x2000_0000 | 0x0800_0000 | 0x0400_0000;

    let mut program = vec![load(OFFSET_ARCH)];
    program.push(instr(BPF_JMP | BPF_JEQ, 1, 0, audit_arch)); // match -> skip EPERM
    program.push(ret_eperm);
    program.push(load(OFFSET_NR));
    for syscall in &denied {
        program.push(instr(BPF_JMP | BPF_JEQ, 0, 1, *syscall as u32));
        program.push(ret_eperm);
    }
    // clone/clone3: deny only when the flag word carries namespace bits.
    // clone3's arg0 is a POINTER to struct clone_args (flags at offset 0),
    // which classic BPF cannot dereference, so its flag word cannot be
    // inspected. Returning ENOSYS for clone3 makes glibc fall back to the
    // plain clone syscall, whose flags ARE in arg0 and are checked below
    // (the same technique Chromium uses). Threads pass; namespaces die.
    program.push(instr(BPF_JMP | BPF_JEQ, 0, 1, libc::SYS_clone3 as u32));
    program.push(ret_enosys);
    program.push(instr(BPF_JMP | BPF_JEQ, 0, 3, libc::SYS_clone as u32));
    program.push(load(OFFSET_ARG0));
    program.push(instr(BPF_JMP | BPF_JSET, 0, 1, NS_FLAGS as u32));
    program.push(ret_eperm);
    // C3: socket denial is unconditional. One rule closes TCP, UDP,
    // AF_UNIX, and netlink creation, which owns W-3 on every supported
    // kernel; there is no Landlock-network conditional to disagree with.
    for syscall in [
        libc::SYS_socket,
        libc::SYS_socketpair,
        libc::SYS_connect,
        libc::SYS_bind,
        libc::SYS_listen,
        libc::SYS_accept,
        libc::SYS_accept4,
        libc::SYS_sendto,
        libc::SYS_recvfrom,
    ] {
        program.push(instr(BPF_JMP | BPF_JEQ, 0, 1, syscall as u32));
        program.push(ret_eperm);
    }
    program.push(ret_allow);

    program
}

/// Installs a prebuilt program (M2: the forked test child must not
/// allocate, so the Vec is built before the fork and passed in).
#[cfg(target_os = "linux")]
fn install_seccomp_program(program: &[seccomp_ffi::sock_filter]) -> Result<(), String> {
    use seccomp_ffi::*;

    let fprog = sock_fprog {
        len: program.len() as u16,
        filter: program.as_ptr(),
    };
    let rc = unsafe {
        libc::syscall(
            libc::SYS_seccomp,
            SECCOMP_SET_MODE_FILTER,
            0u32,
            &fprog as *const sock_fprog,
        )
    };
    if rc < 0 {
        Err(format!("seccomp: {}", std::io::Error::last_os_error()))
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worker::proto::LandlockStatus;

    #[test]
    fn unsupported_landlock_fails_closed() {
        assert!(check(&LandlockStatus::Unsupported).is_err());
        assert!(check(&LandlockStatus::Applied { abi: 4 }).is_ok());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn handled_fs_bits_track_the_probed_abi() {
        // C2 pin: handled bits grow only with the ABI the kernel reported,
        // so an older kernel never handles an access bit it cannot enforce.
        let abi1 = landlock_ffi::fs_bits(1);
        assert_eq!(abi1 & (1 << 13), 0, "REFER is ABI 2+");
        let abi2 = landlock_ffi::fs_bits(2);
        assert_ne!(abi2 & (1 << 13), 0);
        assert_eq!(abi2 & (1 << 14), 0, "TRUNCATE is ABI 3+");
        assert_eq!(landlock_ffi::fs_bits(3) & (1 << 14), 1 << 14);
        assert_eq!(
            landlock_ffi::fs_bits(5) & (1 << 15),
            1 << 15,
            "IOCTL_DEV is ABI 5+"
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn landlock_ruleset_attr_is_fs_only_so_no_e2big_negotiation_exists() {
        // C2 pin: the attribute is the 8-byte fs-only struct every
        // Landlock kernel accepts. The 16-byte struct with
        // handled_access_net is rejected with E2BIG on kernels below 6.7,
        // which is one reason the network bits are gone.
        assert_eq!(
            std::mem::size_of::<landlock_ffi::LandlockRulesetAttr>(),
            std::mem::size_of::<u64>()
        );
    }

    #[test]
    fn landlock_denies_open_in_the_applying_thread() {
        if !landlock_supported() {
            eprintln!("skipping: kernel lacks Landlock (5.13+)");
            return;
        }
        // Landlock is thread-scoped: this restriction affects this test's
        // thread only, never sibling tests. The scratch dir is created
        // first; tempfile's Drop tolerates a denied unlink at teardown.
        // restrict_self requires no_new_privs without CAP_SYS_ADMIN, so the
        // test thread sets it first (per-thread; siblings unaffected).
        set_no_new_privs().expect("no_new_privs applies");
        let scratch = tempfile::tempdir().unwrap();
        let readable = scratch.path().join("before.txt");
        std::fs::write(&readable, b"ok").unwrap();
        apply_landlock_deny_all().expect("landlock applies");
        assert!(
            std::fs::read(&readable).is_err(),
            "landlock must deny filesystem reads, even on pre-existing paths"
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn seccomp_denies_socket_creation() {
        // A seccomp filter is process-wide and irreversible, and the test
        // process is multithreaded: the BPF program is built BEFORE the
        // fork (M2), so the forked child only runs async-signal-safe
        // syscalls (prctl, install, socket, _exit).
        if !landlock_supported() {
            eprintln!("skipping: sandbox layer only meaningful on supported kernels");
            return;
        }
        let program = build_seccomp_program();
        let pid = unsafe { libc::fork() };
        assert!(pid >= 0);
        if pid == 0 {
            // Unprivileged seccomp requires no_new_privs; prctl is
            // async-signal-safe, so it is safe in the forked child.
            unsafe {
                libc::prctl(38 /* PR_SET_NO_NEW_PRIVS */, 1, 0, 0, 0)
            };
            if install_seccomp_program(&program).is_err() {
                unsafe { libc::_exit(2) };
            }
            let fd = unsafe { libc::socket(libc::AF_INET, libc::SOCK_STREAM, 0) };
            let socket_denied = fd == -1 && unsafe { *libc::__errno_location() } == libc::EPERM;
            if !socket_denied {
                unsafe { libc::_exit(1) };
            }
            // clone3 must answer ENOSYS (forcing glibc's fallback to the
            // inspectable clone), not EPERM: threads are created through
            // clone3 on modern glibc, and EPERM there would kill thread
            // creation for entirely benign parsers (lopdf uses rayon).
            let rc = unsafe {
                libc::syscall(libc::SYS_clone3, std::ptr::null::<libc::c_void>(), 0usize)
            };
            if !(rc == -1 && unsafe { *libc::__errno_location() } == libc::ENOSYS) {
                unsafe { libc::_exit(3) };
            }
            // A clone carrying a namespace flag must die with EPERM.
            // (Unprivileged kernels reject it too, but under the filter the
            // denial is filter-owned, before the kernel ever sees it.)
            let rc = unsafe {
                libc::syscall(
                    libc::SYS_clone,
                    0x0002_0000 | libc::SIGCHLD, // CLONE_NEWNS
                    0usize,
                )
            };
            if !(rc == -1 && unsafe { *libc::__errno_location() } == libc::EPERM) {
                unsafe { libc::_exit(4) };
            }
            unsafe { libc::_exit(0) };
        }
        let mut status = 0;
        assert_eq!(unsafe { libc::waitpid(pid, &mut status, 0) }, pid);
        assert!(
            libc::WIFEXITED(status) && libc::WEXITSTATUS(status) == 0,
            "socket() must be denied under the filter"
        );
    }
}
