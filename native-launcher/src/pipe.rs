use std::ffi::{OsStr, c_void};
use std::io;
use std::mem::{offset_of, size_of};
use std::os::windows::ffi::OsStrExt;
use std::ptr::null_mut;

type Handle = *mut c_void;
type Dword = u32;
type Bool = i32;

const INVALID_HANDLE_VALUE: Handle = -1isize as Handle;
const TOKEN_QUERY: Dword = 0x0008;
const TOKEN_GROUPS: Dword = 2;
const SE_GROUP_LOGON_ID: Dword = 0xC000_0000;
const ERROR_INSUFFICIENT_BUFFER: Dword = 122;
const ERROR_PIPE_CONNECTED: Dword = 535;
const ERROR_BROKEN_PIPE: Dword = 109;
const PIPE_ACCESS_DUPLEX: Dword = 0x0000_0003;
const FILE_FLAG_FIRST_PIPE_INSTANCE: Dword = 0x0008_0000;
const PIPE_TYPE_BYTE: Dword = 0;
const PIPE_READMODE_BYTE: Dword = 0;
const PIPE_WAIT: Dword = 0;
const PIPE_REJECT_REMOTE_CLIENTS: Dword = 0x0000_0008;
const GENERIC_READ: Dword = 0x8000_0000;
const GENERIC_WRITE: Dword = 0x4000_0000;
const OPEN_EXISTING: Dword = 3;
const SDDL_REVISION_1: Dword = 1;
const SDDL_REVISION: Dword = 1;
const SE_KERNEL_OBJECT: Dword = 6;
const DACL_SECURITY_INFORMATION: Dword = 0x0000_0004;
const ACL_SIZE_INFORMATION: Dword = 2;
const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;
const FILE_ALL_ACCESS: Dword = 0x001F_01FF;
const HANDLE_FLAG_INHERIT: Dword = 1;
const BCRYPT_USE_SYSTEM_PREFERRED_RNG: Dword = 2;
const MAX_FRAME_BYTES: usize = 1024 * 1024;

#[repr(C)]
struct SecurityAttributes {
    length: Dword,
    security_descriptor: *mut c_void,
    inherit_handle: Bool,
}

#[repr(C)]
struct SidAndAttributes {
    sid: *mut c_void,
    attributes: Dword,
}

#[repr(C)]
struct TokenGroupsOne {
    count: Dword,
    first: SidAndAttributes,
}

#[repr(C)]
struct AclSizeInfo {
    ace_count: Dword,
    bytes_in_use: Dword,
    bytes_free: Dword,
}

#[repr(C)]
struct AceHeader {
    ace_type: u8,
    ace_flags: u8,
    ace_size: u16,
}

#[repr(C)]
struct AccessAllowedAce {
    header: AceHeader,
    mask: Dword,
    sid_start: Dword,
}

#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetCurrentProcess() -> Handle;
    fn GetCurrentProcessId() -> Dword;
    fn CloseHandle(handle: Handle) -> Bool;
    fn CreateNamedPipeW(
        name: *const u16,
        open_mode: Dword,
        pipe_mode: Dword,
        max_instances: Dword,
        out_buffer_size: Dword,
        in_buffer_size: Dword,
        default_timeout: Dword,
        security_attributes: *mut SecurityAttributes,
    ) -> Handle;
    fn ConnectNamedPipe(pipe: Handle, overlapped: *mut c_void) -> Bool;
    fn DisconnectNamedPipe(pipe: Handle) -> Bool;
    fn GetNamedPipeClientProcessId(pipe: Handle, client_pid: *mut Dword) -> Bool;
    fn ReadFile(
        file: Handle,
        buffer: *mut c_void,
        bytes_to_read: Dword,
        bytes_read: *mut Dword,
        overlapped: *mut c_void,
    ) -> Bool;
    fn WriteFile(
        file: Handle,
        buffer: *const c_void,
        bytes_to_write: Dword,
        bytes_written: *mut Dword,
        overlapped: *mut c_void,
    ) -> Bool;
    fn CreateFileW(
        name: *const u16,
        desired_access: Dword,
        share_mode: Dword,
        security_attributes: *mut c_void,
        creation_disposition: Dword,
        flags_and_attributes: Dword,
        template_file: Handle,
    ) -> Handle;
    fn GetHandleInformation(handle: Handle, flags: *mut Dword) -> Bool;
    fn LocalFree(memory: Handle) -> Handle;
    fn GetSecurityInfo(
        handle: Handle,
        object_type: Dword,
        security_info: Dword,
        owner: *mut *mut c_void,
        group: *mut *mut c_void,
        dacl: *mut *mut c_void,
        sacl: *mut *mut c_void,
        security_descriptor: *mut *mut c_void,
    ) -> Dword;
    fn GetAclInformation(
        acl: *mut c_void,
        information: *mut c_void,
        information_length: Dword,
        information_class: Dword,
    ) -> Bool;
    fn GetAce(acl: *mut c_void, ace_index: Dword, ace: *mut *mut c_void) -> Bool;
}

#[link(name = "advapi32")]
unsafe extern "system" {
    fn OpenProcessToken(process: Handle, desired_access: Dword, token: *mut Handle) -> Bool;
    fn GetTokenInformation(
        token: Handle,
        information_class: Dword,
        information: *mut c_void,
        information_length: Dword,
        return_length: *mut Dword,
    ) -> Bool;
    fn ConvertSidToStringSidW(sid: *mut c_void, string_sid: *mut *mut u16) -> Bool;
    fn ConvertStringSecurityDescriptorToSecurityDescriptorW(
        string: *const u16,
        revision: Dword,
        descriptor: *mut *mut c_void,
        size: *mut Dword,
    ) -> Bool;
    fn GetSecurityDescriptorDacl(
        descriptor: *mut c_void,
        present: *mut Bool,
        dacl: *mut *mut c_void,
        defaulted: *mut Bool,
    ) -> Bool;
    fn EqualSid(sid1: *mut c_void, sid2: *mut c_void) -> Bool;
}

#[link(name = "bcrypt")]
unsafe extern "system" {
    fn BCryptGenRandom(algorithm: Handle, buffer: *mut u8, length: Dword, flags: Dword) -> i32;
}

struct OwnedHandle(Handle);

// Windows handles are process-wide kernel objects and may be moved to the dedicated relay thread.
unsafe impl Send for OwnedHandle {}

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        if !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

struct LocalMemory(Handle);

impl Drop for LocalMemory {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                LocalFree(self.0);
            }
        }
    }
}

fn wide(value: &str) -> Vec<u16> {
    OsStr::new(value).encode_wide().chain(Some(0)).collect()
}

fn current_logon_sid() -> io::Result<(String, LocalMemory)> {
    let mut token = null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let token = OwnedHandle(token);
    let mut required = 0;
    let first = unsafe { GetTokenInformation(token.0, TOKEN_GROUPS, null_mut(), 0, &mut required) };
    if first != 0 || unsafe { GetLastError() } != ERROR_INSUFFICIENT_BUFFER {
        return Err(io::Error::last_os_error());
    }
    let words = (required as usize).div_ceil(size_of::<usize>());
    let mut buffer = vec![0usize; words];
    if unsafe {
        GetTokenInformation(
            token.0,
            TOKEN_GROUPS,
            buffer.as_mut_ptr().cast(),
            required,
            &mut required,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let groups = buffer.as_ptr().cast::<TokenGroupsOne>();
    let count = unsafe { (*groups).count as usize };
    let first_group = unsafe {
        (buffer
            .as_ptr()
            .cast::<u8>()
            .add(offset_of!(TokenGroupsOne, first)))
        .cast::<SidAndAttributes>()
    };
    let logon_sid = (0..count)
        .find_map(|index| {
            let entry = unsafe { &*first_group.add(index) };
            (entry.attributes & SE_GROUP_LOGON_ID == SE_GROUP_LOGON_ID).then_some(entry.sid)
        })
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::PermissionDenied,
                "current token has no logon SID",
            )
        })?;
    let mut sid_string = null_mut();
    if unsafe { ConvertSidToStringSidW(logon_sid, &mut sid_string) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let sid_memory = LocalMemory(sid_string.cast());
    let mut length = 0;
    unsafe {
        while *sid_string.add(length) != 0 {
            length += 1;
        }
    }
    let sid = String::from_utf16(unsafe { std::slice::from_raw_parts(sid_string, length) })
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "logon SID was not UTF-16"))?;
    Ok((sid, sid_memory))
}

fn random_pipe_name() -> io::Result<String> {
    let mut random = [0u8; 16];
    let status = unsafe {
        BCryptGenRandom(
            null_mut(),
            random.as_mut_ptr(),
            random.len() as Dword,
            BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        )
    };
    if status != 0 {
        return Err(io::Error::from_raw_os_error(status));
    }
    let suffix = random
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Ok(format!(r"\\.\pipe\quota-resume-{suffix}"))
}

fn write_all(handle: Handle, mut bytes: &[u8]) -> io::Result<()> {
    while !bytes.is_empty() {
        let mut written = 0;
        if unsafe {
            WriteFile(
                handle,
                bytes.as_ptr().cast(),
                bytes.len().min(u32::MAX as usize) as Dword,
                &mut written,
                null_mut(),
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        if written == 0 {
            return Err(io::Error::new(
                io::ErrorKind::WriteZero,
                "pipe write returned zero",
            ));
        }
        bytes = &bytes[written as usize..];
    }
    Ok(())
}

fn read_exact(handle: Handle, mut bytes: &mut [u8]) -> io::Result<()> {
    while !bytes.is_empty() {
        let mut read = 0;
        if unsafe {
            ReadFile(
                handle,
                bytes.as_mut_ptr().cast(),
                bytes.len().min(u32::MAX as usize) as Dword,
                &mut read,
                null_mut(),
            )
        } == 0
        {
            let error = io::Error::last_os_error();
            return Err(io::Error::new(
                error.kind(),
                format!("read pipe frame: {error}"),
            ));
        }
        if read == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "pipe closed mid-frame",
            ));
        }
        bytes = &mut bytes[read as usize..];
    }
    Ok(())
}

fn write_frame(handle: Handle, frame: &str) -> io::Result<()> {
    let bytes = frame.as_bytes();
    if bytes.len() > MAX_FRAME_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "pipe frame exceeds size limit",
        ));
    }
    write_all(handle, &(bytes.len() as u32).to_le_bytes())?;
    write_all(handle, bytes)
}

fn read_frame(handle: Handle) -> io::Result<String> {
    let mut header = [0u8; 4];
    read_exact(handle, &mut header)?;
    let length = u32::from_le_bytes(header) as usize;
    if length > MAX_FRAME_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "pipe frame exceeds size limit",
        ));
    }
    let mut bytes = vec![0u8; length];
    read_exact(handle, &mut bytes)?;
    String::from_utf8(bytes)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "pipe frame is not UTF-8"))
}

pub struct PipeServer {
    handle: OwnedHandle,
    name: String,
    logon_sid: String,
    connected: bool,
    peer_pid: Option<u32>,
}

impl PipeServer {
    pub fn create() -> io::Result<Self> {
        let name = random_pipe_name()?;
        Self::create_named(name)
    }

    /// Create a single-instance server at an explicit name. Recreate it only after the prior
    /// instance has been dropped; this lets the broker serialize worker requests on one endpoint.
    pub fn create_named(name: String) -> io::Result<Self> {
        if !name.starts_with(r"\\.\pipe\quota-resume-") {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid broker pipe name",
            ));
        }
        let (logon_sid, _sid_memory) = current_logon_sid()?;
        let sddl = wide(&format!("D:P(A;;GA;;;{logon_sid})"));
        let mut descriptor = null_mut();
        if unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                null_mut(),
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        let descriptor = LocalMemory(descriptor);
        let mut attributes = SecurityAttributes {
            length: size_of::<SecurityAttributes>() as Dword,
            security_descriptor: descriptor.0,
            inherit_handle: 0,
        };
        let flags = PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE;
        let mode = PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS;
        let handle = unsafe {
            CreateNamedPipeW(
                wide(&name).as_ptr(),
                flags,
                mode,
                1,
                64 * 1024,
                64 * 1024,
                0,
                &mut attributes,
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            let error = io::Error::last_os_error();
            return Err(io::Error::new(
                error.kind(),
                format!("create named pipe {name}: {error}"),
            ));
        }
        Ok(Self {
            handle: OwnedHandle(handle),
            name,
            logon_sid,
            connected: false,
            peer_pid: None,
        })
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn peer_pid(&self) -> Option<u32> {
        self.peer_pid
    }

    fn accept_connected_peer(&mut self) -> io::Result<u32> {
        let connected = unsafe { ConnectNamedPipe(self.handle.0, null_mut()) };
        if connected == 0 && unsafe { GetLastError() } != ERROR_PIPE_CONNECTED {
            return Err(io::Error::last_os_error());
        }
        self.connected = true;
        let mut peer_pid = 0;
        if unsafe { GetNamedPipeClientProcessId(self.handle.0, &mut peer_pid) } == 0 {
            return Err(io::Error::last_os_error());
        }
        self.peer_pid = Some(peer_pid);
        Ok(peer_pid)
    }

    /// Accept a same-logon client; the Node operation layer must authenticate its token and target.
    pub fn accept_logon_peer(&mut self) -> io::Result<u32> {
        self.accept_connected_peer()
    }

    /// Accept the designated host child only; this is the host-side pipe policy.
    pub fn accept_and_verify_peer(&mut self, expected_pid: u32) -> io::Result<()> {
        let peer_pid = self.accept_connected_peer()?;
        if peer_pid != expected_pid {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!("pipe peer PID {peer_pid} did not match expected child PID {expected_pid}"),
            ));
        }
        Ok(())
    }

    pub fn write_frame(&self, frame: &str) -> io::Result<()> {
        if !self.connected {
            return Err(io::Error::new(
                io::ErrorKind::NotConnected,
                "pipe not connected",
            ));
        }
        write_frame(self.handle.0, frame)
    }

    pub fn read_frame(&self) -> io::Result<String> {
        if !self.connected {
            return Err(io::Error::new(
                io::ErrorKind::NotConnected,
                "pipe not connected",
            ));
        }
        read_frame(self.handle.0)
    }

    /// Wait until the one-request worker closes its write side after reading the response.
    /// This prevents DisconnectNamedPipe from discarding a response still buffered for the client.
    pub fn finish_one_request(&self) -> io::Result<()> {
        let mut extra = 0u8;
        let mut read = 0;
        let success = unsafe {
            ReadFile(
                self.handle.0,
                (&mut extra as *mut u8).cast(),
                1,
                &mut read,
                null_mut(),
            )
        };
        if success != 0 && read == 0 {
            return Ok(());
        }
        if success != 0 && read != 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "worker sent data after its single request",
            ));
        }
        let error = unsafe { GetLastError() };
        if error == ERROR_BROKEN_PIPE {
            Ok(())
        } else {
            Err(io::Error::from_raw_os_error(error as i32))
        }
    }

    pub fn handle_is_inheritable(&self) -> io::Result<bool> {
        let mut flags = 0;
        if unsafe { GetHandleInformation(self.handle.0, &mut flags) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(flags & HANDLE_FLAG_INHERIT != 0)
    }

    pub fn dacl_is_logon_sid_only(&self) -> io::Result<bool> {
        let mut descriptor = null_mut();
        let error = unsafe {
            GetSecurityInfo(
                self.handle.0,
                SE_KERNEL_OBJECT,
                DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                null_mut(),
                null_mut(),
                &mut descriptor,
            )
        };
        if error != 0 {
            return Err(io::Error::from_raw_os_error(error as i32));
        }
        let descriptor = LocalMemory(descriptor);
        let mut present = 0;
        let mut dacl = null_mut();
        let mut defaulted = 0;
        if unsafe {
            GetSecurityDescriptorDacl(descriptor.0, &mut present, &mut dacl, &mut defaulted)
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        if present == 0 || dacl.is_null() {
            return Ok(false);
        }
        let mut size = AclSizeInfo {
            ace_count: 0,
            bytes_in_use: 0,
            bytes_free: 0,
        };
        if unsafe {
            GetAclInformation(
                dacl,
                (&mut size as *mut AclSizeInfo).cast(),
                size_of::<AclSizeInfo>() as Dword,
                ACL_SIZE_INFORMATION,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        if size.ace_count != 1 {
            return Ok(false);
        }
        let mut ace_ptr = null_mut();
        if unsafe { GetAce(dacl, 0, &mut ace_ptr) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let ace = unsafe { &*ace_ptr.cast::<AccessAllowedAce>() };
        if ace.header.ace_type != ACCESS_ALLOWED_ACE_TYPE || ace.mask != FILE_ALL_ACCESS {
            return Ok(false);
        }
        let sid = (&ace.sid_start as *const Dword).cast_mut().cast::<c_void>();
        let (expected_sid_text, _sid_memory) = current_logon_sid()?;
        let expected_sddl = wide(&format!("D:P(A;;GA;;;{expected_sid_text})"));
        let mut expected_descriptor = null_mut();
        if unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                expected_sddl.as_ptr(),
                SDDL_REVISION,
                &mut expected_descriptor,
                null_mut(),
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        let expected_descriptor = LocalMemory(expected_descriptor);
        let mut expected_present = 0;
        let mut expected_dacl = null_mut();
        let mut expected_defaulted = 0;
        if unsafe {
            GetSecurityDescriptorDacl(
                expected_descriptor.0,
                &mut expected_present,
                &mut expected_dacl,
                &mut expected_defaulted,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        let mut expected_ace_ptr = null_mut();
        if unsafe { GetAce(expected_dacl, 0, &mut expected_ace_ptr) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let expected_ace = unsafe { &*expected_ace_ptr.cast::<AccessAllowedAce>() };
        let expected_sid = (&expected_ace.sid_start as *const Dword)
            .cast_mut()
            .cast::<c_void>();
        let equal_sid = unsafe { EqualSid(sid, expected_sid) } != 0;
        Ok(equal_sid && self.logon_sid == expected_sid_text)
    }
}

impl Drop for PipeServer {
    fn drop(&mut self) {
        if self.connected {
            unsafe {
                DisconnectNamedPipe(self.handle.0);
            }
        }
    }
}

pub struct PipeClient {
    handle: OwnedHandle,
}

impl PipeClient {
    pub fn connect(name: &str) -> io::Result<Self> {
        let handle = unsafe {
            CreateFileW(
                wide(name).as_ptr(),
                GENERIC_READ | GENERIC_WRITE,
                0,
                null_mut(),
                OPEN_EXISTING,
                0,
                null_mut(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        Ok(Self {
            handle: OwnedHandle(handle),
        })
    }

    pub fn write_frame(&self, frame: &str) -> io::Result<()> {
        write_frame(self.handle.0, frame)
    }

    pub fn read_frame(&self) -> io::Result<String> {
        read_frame(self.handle.0)
    }
}

pub fn current_process_id() -> u32 {
    unsafe { GetCurrentProcessId() }
}

pub const fn pipe_creation_flags() -> (u32, u32, bool) {
    (
        PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
        PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
        false,
    )
}

#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetLastError() -> Dword;
}
