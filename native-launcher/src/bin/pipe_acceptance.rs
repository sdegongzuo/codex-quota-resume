#[cfg(windows)]
fn main() {
    use quota_resume_native_launcher::pipe::{
        PipeClient, PipeServer, current_process_id, pipe_creation_flags,
    };
    use std::process::{Command, Stdio};

    if let Some(pipe_name) = std::env::args()
        .nth(1)
        .filter(|arg| arg == "--client")
        .and_then(|_| std::env::args().nth(2))
    {
        let result = (|| {
            let client = PipeClient::connect(&pipe_name)?;
            client.write_frame("pipe-frame-握手-✓")?;
            let response = client.read_frame()?;
            if response != "pipe-frame-回执-✓" {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "frame reply mismatch",
                ));
            }
            Ok::<(), std::io::Error>(())
        })();
        if let Err(error) = result {
            eprintln!("pipe client failed: {error}");
            std::process::exit(1);
        }
        return;
    }

    let mut server = match PipeServer::create() {
        Ok(server) => server,
        Err(error) => {
            eprintln!("pipe server create failed: {error}");
            std::process::exit(1);
        }
    };
    let pipe_name = server.name().to_owned();
    let executable = std::env::current_exe().expect("resolve isolated acceptance executable");
    let mut child = match Command::new(executable)
        .arg("--client")
        .arg(&pipe_name)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            eprintln!("pipe client spawn failed: {error}");
            std::process::exit(1);
        }
    };
    let expected_pid = child.id();

    let peer_verified = server.accept_and_verify_peer(expected_pid).is_ok()
        && server.peer_pid() == Some(expected_pid);
    let peer_pid = server.peer_pid().unwrap_or(0);
    let incoming = server.read_frame();
    let round_trip = matches!(&incoming, Ok(value) if value == "pipe-frame-握手-✓");
    let reply_written = server.write_frame("pipe-frame-回执-✓").is_ok();
    let client_ok = child.wait().is_ok_and(|status| status.success());
    let dacl_result = server.dacl_is_logon_sid_only();
    let dacl_restricted = dacl_result.as_ref().copied().unwrap_or(false);
    if let Err(error) = dacl_result {
        eprintln!("DACL inspection failed: {error}");
    }
    let handle_inheritable = server.handle_is_inheritable().unwrap_or(true);
    let (open_flags, pipe_mode, configured_inherit) = pipe_creation_flags();
    let passed = peer_verified
        && round_trip
        && reply_written
        && client_ok
        && dacl_restricted
        && !handle_inheritable
        && !configured_inherit;
    println!(
        "{{\"passed\":{passed},\"peerPid\":{peer_pid},\"expectedChildPid\":{expected_pid},\"peerPidVerified\":{peer_verified},\"utf8FrameRoundTrip\":{},\"daclLogonSidOnly\":{dacl_restricted},\"handleInheritable\":{handle_inheritable},\"pipeRejectRemoteClients\":{},\"firstPipeInstance\":{},\"peerIsChildProcess\":{}}}",
        round_trip && reply_written && client_ok,
        pipe_mode & 0x8 != 0,
        open_flags & 0x0008_0000 != 0,
        expected_pid != current_process_id()
    );
    if !passed {
        std::process::exit(1);
    }
}

#[cfg(not(windows))]
fn main() {
    eprintln!("pipe acceptance requires Windows");
    std::process::exit(1);
}
