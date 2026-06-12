//! Cross-platform child-process teardown.
//!
//! Windows: `Child::kill()` only terminates the direct child (TerminateProcess
//! on a single PID). The Hunyuan server (python -> torch) and the uvicorn worker
//! both spawn descendant processes that outlive a bare kill and keep holding GPU
//! VRAM. `taskkill /F /T /PID <pid>` walks and kills the whole tree, freeing the
//! GPU on a manual "stop server" or on app exit.

use std::process::Child;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Kill `child` together with all of its descendants, then reap it.
///
/// No-op (besides reaping) if the child has already exited.
pub fn kill_child_tree(child: &mut Child) {
    if matches!(child.try_wait(), Ok(Some(_))) {
        return;
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let pid = child.id();
        let _ = std::process::Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .creation_flags(CREATE_NO_WINDOW)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
    #[cfg(not(windows))]
    {
        let _ = child.kill();
    }
    let _ = child.wait();
}
