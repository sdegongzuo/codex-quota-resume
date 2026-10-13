use std::env;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, Stdio};

const ORIGINAL_CLI: &str = "QUOTA_RESUME_ORIGINAL_CLI";
const NODE: &str = "QUOTA_RESUME_NODE";
const HOST_SCRIPT: &str = "QUOTA_RESUME_HOST_SCRIPT";
const BROKER: &str = "QUOTA_RESUME_BROKER";
const CLI_PATH_OVERRIDE: &str = "CODEX_CLI_PATH";

#[derive(Clone, Debug, PartialEq, Eq)]
enum Invocation {
    AppServer,
    PassThrough,
}

fn top_level_command(args: &[OsString]) -> Option<&OsStr> {
    let mut index = 1;
    while let Some(arg) = args.get(index) {
        if arg == OsStr::new("-c") || arg == OsStr::new("--config") {
            index += 2;
            continue;
        }
        if arg.to_string_lossy().starts_with("--config=")
            || arg.to_string_lossy().starts_with("-c=")
        {
            index += 1;
            continue;
        }
        if arg == OsStr::new("--cd")
            || arg == OsStr::new("--profile")
            || arg == OsStr::new("--model")
            || arg == OsStr::new("--sandbox")
            || arg == OsStr::new("--ask-for-approval")
            || arg == OsStr::new("--oss")
        {
            index += 2;
            continue;
        }
        if arg.to_string_lossy().starts_with('-') {
            index += 1;
            continue;
        }
        return Some(arg);
    }
    None
}

fn classify(args: &[OsString]) -> Invocation {
    if top_level_command(args).is_some_and(|command| command == OsStr::new("app-server")) {
        Invocation::AppServer
    } else {
        Invocation::PassThrough
    }
}

fn configured_absolute(name: &str) -> Result<PathBuf, String> {
    let value =
        env::var_os(name).ok_or_else(|| format!("missing required environment variable {name}"))?;
    let path = PathBuf::from(value);
    if !path.is_absolute() {
        return Err(format!("{name} must be an absolute path"));
    }
    if !path.is_file() {
        return Err(format!("{name} does not point to a file"));
    }
    Ok(path)
}

fn optional_absolute(name: &str, value: Option<OsString>) -> Result<Option<PathBuf>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    let path = PathBuf::from(value);
    if !path.is_absolute() {
        return Err(format!("{name} must be an absolute path"));
    }
    if !path
        .extension()
        .and_then(OsStr::to_str)
        .is_some_and(|extension| extension.eq_ignore_ascii_case("exe"))
    {
        return Err(format!("{name} must point to an .exe file"));
    }
    if !path.is_file() {
        return Err(format!("{name} does not point to a file"));
    }
    Ok(Some(path))
}

fn configured_optional_absolute(name: &str) -> Result<Option<PathBuf>, String> {
    optional_absolute(name, env::var_os(name))
}

fn same_file(left: &Path, right: &Path) -> bool {
    match (left.canonicalize(), right.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => left
            .to_string_lossy()
            .eq_ignore_ascii_case(&right.to_string_lossy()),
    }
}

fn ensure_distinct(candidate: &Path, peers: &[(&str, &Path)]) -> Result<(), String> {
    if let Some((name, _)) = peers.iter().find(|(_, peer)| same_file(candidate, peer)) {
        return Err(format!(
            "configured broker resolves to {name}; refusing recursive launch"
        ));
    }
    Ok(())
}

fn forwarded_args(args: &[OsString]) -> &[OsString] {
    args.get(1..).unwrap_or_default()
}

fn select_broker(invocation: &Invocation, configured: Option<PathBuf>) -> Option<PathBuf> {
    if *invocation == Invocation::AppServer {
        configured
    } else {
        None
    }
}

fn child_status(mut command: Command) -> Result<i32, String> {
    let status = command
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()
        .map_err(|error| format!("failed to start child process: {error}"))?;
    Ok(child_exit_code(status.code()))
}

fn child_exit_code(code: Option<i32>) -> i32 {
    code.unwrap_or(1)
}

fn run() -> Result<i32, String> {
    let args: Vec<OsString> = env::args_os().collect();
    let launcher =
        env::current_exe().map_err(|error| format!("cannot resolve launcher path: {error}"))?;
    let original = configured_absolute(ORIGINAL_CLI)?;
    if same_file(&launcher, &original) {
        return Err(format!(
            "{ORIGINAL_CLI} resolves to this launcher; refusing recursive launch"
        ));
    }

    match classify(&args) {
        Invocation::PassThrough => {
            let mut command = Command::new(&original);
            command.args(forwarded_args(&args));
            command.env(CLI_PATH_OVERRIDE, &original);
            child_status(command)
        }
        Invocation::AppServer => {
            let configured_broker = configured_optional_absolute(BROKER)?;
            if let Some(broker) = select_broker(&Invocation::AppServer, configured_broker) {
                let node = configured_absolute(NODE)?;
                ensure_distinct(
                    &broker,
                    &[
                        ("launcher", &launcher),
                        ("original CLI", &original),
                        ("Node", &node),
                    ],
                )?;
                let mut command = Command::new(&broker);
                command.args(forwarded_args(&args));
                command
                    .env(CLI_PATH_OVERRIDE, &original)
                    .env(ORIGINAL_CLI, &original);
                return child_status(command);
            }
            let node = configured_absolute(NODE)?;
            let host = configured_absolute(HOST_SCRIPT)?;
            if same_file(&launcher, &node) || same_file(&launcher, &host) {
                return Err(
                    "Node or host script resolves to the launcher; refusing recursive launch"
                        .into(),
                );
            }
            let mut command = Command::new(node);
            command.arg(host).args(forwarded_args(&args));
            command.env(CLI_PATH_OVERRIDE, &original);
            child_status(command)
        }
    }
}

fn main() -> ExitCode {
    match run() {
        Ok(code) => std::process::exit(code),
        Err(message) => {
            eprintln!("quota-resume-launcher: {message}");
            ExitCode::from(78)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        Invocation, classify, ensure_distinct, forwarded_args, optional_absolute, select_broker,
        top_level_command,
    };
    use std::ffi::OsString;
    use std::path::Path;

    #[test]
    fn app_server_subcommand_is_routed_to_host() {
        let args = [
            OsString::from("codex"),
            OsString::from("app-server"),
            OsString::from("--listen"),
            OsString::from("stdio"),
        ];
        assert_eq!(classify(&args), Invocation::AppServer);
    }

    #[test]
    fn desktop_global_config_arguments_are_skipped_before_command() {
        let args = [
            "codex",
            "-c",
            "features.code_mode_host=true",
            "app-server",
            "--analytics-default-enabled",
            "-c",
            "features.prefer_mxc=true",
            "--listen",
            "stdio",
        ]
        .map(OsString::from);
        assert_eq!(classify(&args), Invocation::AppServer);
    }

    #[test]
    fn config_value_named_app_server_is_not_a_command() {
        for flag in ["-c", "--config"] {
            let args = ["codex", flag, "app-server", "--version"].map(OsString::from);
            assert_eq!(classify(&args), Invocation::PassThrough);
        }
        let inline = ["codex", "--config=app-server", "--version"].map(OsString::from);
        assert_eq!(classify(&inline), Invocation::PassThrough);
        assert_eq!(top_level_command(&inline), None);
    }

    #[test]
    fn other_cli_commands_are_passed_through() {
        for subcommand in ["--version", "--help", "login", "exec", "mcp-server"] {
            let args = [OsString::from("codex"), OsString::from(subcommand)];
            assert_eq!(classify(&args), Invocation::PassThrough);
        }
        assert_eq!(
            classify(&[OsString::from("codex")]),
            Invocation::PassThrough
        );
    }

    #[test]
    fn child_exit_status_preserves_full_windows_code() {
        assert_eq!(super::child_exit_code(Some(513)), 513);
        assert_eq!(super::child_exit_code(None), 1);
    }

    #[test]
    fn unset_broker_configuration_preserves_node_host_route() {
        let configured = optional_absolute("QUOTA_RESUME_BROKER", None).unwrap();
        assert!(configured.is_none());
        let args = ["codex", "app-server", "--listen", "stdio"].map(OsString::from);
        assert_eq!(classify(&args), Invocation::AppServer);
    }

    #[test]
    fn broker_configuration_requires_an_absolute_path() {
        let result = optional_absolute(
            "QUOTA_RESUME_BROKER",
            Some(OsString::from("bin\\pipe-broker.exe")),
        );
        assert!(result.unwrap_err().contains("absolute path"));
    }

    #[test]
    fn broker_configuration_requires_an_existing_file() {
        let result = optional_absolute(
            "QUOTA_RESUME_BROKER",
            Some(OsString::from(r"D:\quota-resume-no-such-broker.exe")),
        );
        assert!(result.unwrap_err().contains("does not point to a file"));
    }

    #[test]
    fn broker_configuration_must_be_an_executable_file() {
        let source_file = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/main.rs");
        let result = optional_absolute("QUOTA_RESUME_BROKER", Some(source_file.into_os_string()));
        assert!(result.unwrap_err().contains(".exe file"));
    }

    #[test]
    fn a_valid_absolute_executable_path_is_accepted_as_broker_configuration() {
        let executable = std::env::current_exe().unwrap();
        let configured = optional_absolute(
            "QUOTA_RESUME_BROKER",
            Some(executable.clone().into_os_string()),
        )
        .unwrap();
        assert_eq!(configured, Some(executable));
    }

    #[test]
    fn broker_configuration_cannot_resolve_to_launcher_original_or_node() {
        let same = Path::new(r"D:\runtime\quota-resume.exe");
        for name in ["launcher", "original CLI", "Node"] {
            let error = ensure_distinct(same, &[(name, same)]).unwrap_err();
            assert!(error.contains(name));
            assert!(error.contains("recursive launch"));
        }
    }

    #[test]
    fn broker_route_forwards_desktop_arguments_without_rewriting_them() {
        let args = [
            "codex",
            "-c",
            "features.code_mode_host=true",
            "app-server",
            "--analytics-default-enabled",
            "-c",
            "features.prefer_mxc=true",
            "--listen",
            "stdio",
        ]
        .map(OsString::from);
        assert_eq!(
            forwarded_args(&args),
            &args[1..],
            "broker must receive the exact original argument sequence"
        );
    }

    #[test]
    fn configuring_a_broker_does_not_change_non_app_server_commands() {
        let args = ["codex", "--version"].map(OsString::from);
        assert_eq!(classify(&args), Invocation::PassThrough);
        assert_eq!(forwarded_args(&args), &args[1..]);
        assert_eq!(
            select_broker(
                &Invocation::PassThrough,
                Some(Path::new("broker.exe").into())
            ),
            None
        );
    }

    #[test]
    fn valid_broker_configuration_is_selected_only_for_app_server() {
        let configured = Some(Path::new(r"D:\runtime\pipe-broker.exe").into());
        assert_eq!(
            select_broker(&Invocation::AppServer, configured.clone()),
            configured
        );
        assert_eq!(select_broker(&Invocation::AppServer, None), None);
    }
}
