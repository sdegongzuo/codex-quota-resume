#[cfg(windows)]
fn main() {
    use quota_resume_native_launcher::pipe::PipeServer;
    use std::env;
    use std::os::windows::io::AsRawHandle;
    use std::process::{Command, Stdio};
    use std::sync::mpsc;
    use std::thread;
    use std::time::{Duration, Instant};

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CancelSynchronousIo(thread: *mut std::ffi::c_void) -> i32;
    }

    fn cancel_and_wait<T>(worker: &thread::JoinHandle<T>, timeout: Duration) -> bool {
        let started = Instant::now();
        while !worker.is_finished() && started.elapsed() < timeout {
            unsafe { CancelSynchronousIo(worker.as_raw_handle().cast()) };
            thread::sleep(Duration::from_millis(10));
        }
        worker.is_finished()
    }

    fn required(name: &str) -> Result<String, String> {
        env::var(name).map_err(|_| format!("missing {name}"))
    }

    fn absolute_file(name: &str) -> Result<String, String> {
        let value = required(name)?;
        let path = std::path::Path::new(&value);
        if !path.is_absolute() || !path.is_file() {
            return Err(format!("{name} must name an existing absolute file"));
        }
        Ok(value)
    }

    fn broker() -> Result<i32, String> {
        let node = absolute_file("QUOTA_RESUME_NODE")?;
        let host_script = absolute_file("QUOTA_RESUME_HOST_SCRIPT")?;
        let original_cli = absolute_file("QUOTA_RESUME_ORIGINAL_CLI")?;
        let mut args = env::args_os().skip(1);
        let mut host_args = Vec::new();
        for arg in args.by_ref() {
            if arg == "--" {
                break;
            }
            host_args.push(arg);
        }

        let host_listener = PipeServer::create().map_err(|e| format!("create host pipe: {e}"))?;
        let host_name = host_listener.name().to_owned();
        let worker_listener =
            PipeServer::create().map_err(|e| format!("create worker pipe: {e}"))?;
        let worker_name = worker_listener.name().to_owned();

        // Host stdio remains attached to the renderer. The private IPC uses distinct pre-created
        // pipes, and the child is told only their names plus the original CLI path.
        let mut child = Command::new(&node)
            .arg(host_script)
            .args(host_args)
            .stdin(Stdio::inherit())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .env("CODEX_CLI_PATH", &original_cli)
            .env("QUOTA_RESUME_ORIGINAL_CLI", &original_cli)
            .env("QUOTA_RESUME_HOST_PIPE", &host_name)
            .env("QUOTA_RESUME_WORKER_PIPE", &worker_name)
            .spawn()
            .map_err(|e| format!("start Node host: {e}"))?;
        let host_pid = child.id();
        let (host_tx, host_rx) = mpsc::channel();
        let host_accept = thread::spawn(move || {
            let mut host = host_listener;
            let result = host
                .accept_and_verify_peer(host_pid)
                .map(|()| host)
                .map_err(|error| error.to_string());
            let _ = host_tx.send(result);
        });
        let host_deadline = Instant::now() + Duration::from_secs(20);
        let host = loop {
            if let Some(status) = child
                .try_wait()
                .map_err(|error| format!("check Node host startup: {error}"))?
            {
                if cancel_and_wait(&host_accept, Duration::from_secs(2)) {
                    let _ = host_accept.join();
                }
                drop(worker_listener);
                return Ok(status.code().unwrap_or(1));
            }
            match host_rx.recv_timeout(Duration::from_millis(50)) {
                Ok(Ok(host)) => break host,
                Ok(Err(error)) => {
                    eprintln!(
                        "quota-resume broker: bridge disabled; host stdio remains active ({error})"
                    );
                    if cancel_and_wait(&host_accept, Duration::from_secs(2)) {
                        let _ = host_accept.join();
                    }
                    drop(worker_listener);
                    return child
                        .wait()
                        .map(|status| status.code().unwrap_or(1))
                        .map_err(|wait_error| format!("wait for Node host: {wait_error}"));
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    eprintln!(
                        "quota-resume broker: bridge disabled; host stdio remains active (host pipe accept stopped)"
                    );
                    drop(worker_listener);
                    return child
                        .wait()
                        .map(|status| status.code().unwrap_or(1))
                        .map_err(|wait_error| format!("wait for Node host: {wait_error}"));
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
            if Instant::now() >= host_deadline {
                eprintln!(
                    "quota-resume broker: bridge disabled after host pipe connect timeout; host stdio remains active"
                );
                if cancel_and_wait(&host_accept, Duration::from_secs(2)) {
                    let _ = host_accept.join();
                }
                drop(worker_listener);
                return child
                    .wait()
                    .map(|status| status.code().unwrap_or(1))
                    .map_err(|error| format!("wait for Node host: {error}"));
            }
        };

        // Keep renderer/backend stdio independent from bridge traffic. A dedicated relay thread
        // handles one worker connection at a time; each worker connection is exactly one request
        // followed by exactly one response. The client owns any retry decision.
        let (relay_tx, relay_rx) = mpsc::channel();
        let relay = thread::spawn(move || -> std::io::Result<()> {
            let mut listener = worker_listener;
            loop {
                listener.accept_logon_peer()?;
                if relay_tx.send((true, String::new())).is_err() {
                    return Ok(());
                }
                let result = (|| {
                    let request = listener.read_frame()?;
                    host.write_frame(&request)?;
                    let response = host.read_frame()?;
                    listener.write_frame(&response)?;
                    listener.finish_one_request()
                })();
                if let Err(error) = result {
                    let _ = relay_tx.send((false, error.to_string()));
                    return Err(error);
                }
                drop(listener);
                listener = PipeServer::create_named(worker_name.clone())?;
                if relay_tx.send((false, String::new())).is_err() {
                    return Ok(());
                }
            }
        });

        let mut worker_deadline = None;
        let status = loop {
            if let Some(status) = child
                .try_wait()
                .map_err(|e| format!("check Node host: {e}"))?
            {
                break status;
            }
            match relay_rx.recv_timeout(Duration::from_millis(50)) {
                Ok((true, _)) => worker_deadline = Some(Instant::now() + Duration::from_secs(20)),
                Ok((false, reason)) if !reason.is_empty() => {
                    eprintln!(
                        "quota-resume broker: bridge disabled after uncertain worker transaction; no retry ({reason})"
                    );
                    if cancel_and_wait(&relay, Duration::from_secs(2)) {
                        let _ = relay.join();
                    }
                    return child
                        .wait()
                        .map(|status| status.code().unwrap_or(1))
                        .map_err(|error| format!("wait for Node host: {error}"));
                }
                Ok((false, _)) => worker_deadline = None,
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    eprintln!(
                        "quota-resume broker: bridge disabled after relay failure; host stdio remains active, no retry"
                    );
                    if cancel_and_wait(&relay, Duration::from_secs(2)) {
                        let _ = relay.join();
                    }
                    return child
                        .wait()
                        .map(|status| status.code().unwrap_or(1))
                        .map_err(|error| format!("wait for Node host: {error}"));
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
            if worker_deadline.is_some_and(|deadline| Instant::now() >= deadline) {
                eprintln!(
                    "quota-resume broker: bridge disabled after 20-second worker deadline; host stdio remains active, no retry"
                );
                if cancel_and_wait(&relay, Duration::from_secs(2)) {
                    let _ = relay.join();
                }
                return child
                    .wait()
                    .map(|status| status.code().unwrap_or(1))
                    .map_err(|error| format!("wait for Node host: {error}"));
            }
        };
        // The relay may be blocked in a pipe operation if a client vanished mid-frame. Process
        // exit is the broker shutdown boundary; it prevents an orphaned broker after host exit.
        if !relay.is_finished() {
            std::process::exit(status.code().unwrap_or(1));
        }
        let _ = relay.join();
        Ok(status.code().unwrap_or(1))
    }

    match broker() {
        Ok(code) => std::process::exit(code),
        Err(error) => {
            eprintln!("quota-resume pipe broker: {error}");
            std::process::exit(78);
        }
    }
}

#[cfg(not(windows))]
fn main() {
    eprintln!("pipe broker requires Windows");
    std::process::exit(1);
}
