//! Windows-safe, opaque relative resource sessions for scene presets.
//!
//! Paths never cross this module's public boundary.  Windows opens are rooted at a
//! retained directory handle using NtCreateFile with RootDirectory and
//! FILE_OPEN_REPARSE_POINT; the portable implementation retains the same handle and
//! applies the equivalent no-follow checks for tests and non-Windows builds.

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Component, Path};
use std::sync::{Arc, Mutex};

pub const MAX_RESOURCES: usize = 4096;
pub const MAX_SESSIONS: usize = 32;
pub const MAX_RESOURCE_BYTES: u64 = 256 * 1024 * 1024;
pub const MAX_SESSION_BYTES: u64 = 1024 * 1024 * 1024;
pub const MAX_RANGE_BYTES: u64 = 16 * 1024 * 1024;
pub const MAX_CONCURRENT: usize = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResourceError {
    InvalidRoot,
    InvalidRelativePath,
    ReparsePoint,
    Missing,
    NotRegularFile,
    UnsupportedResource,
    InvalidSignature,
    TooManyResources,
    TooManySessions,
    ResourceTooLarge,
    SessionQuotaExceeded,
    RangeTooLarge,
    InvalidRange,
    OverlappingRange,
    UnknownSession,
    UnknownResource,
    RouteMismatch,
    StaleGeneration,
    ConcurrentLimit,
    Internal,
}

impl ResourceError {
    pub const fn code(self) -> &'static str {
        match self {
            Self::InvalidRoot | Self::InvalidRelativePath | Self::InvalidRange => {
                "SCENE_RESOURCE_INVALID"
            }
            Self::ReparsePoint => "SCENE_RESOURCE_REPARSE",
            Self::Missing => "SCENE_RESOURCE_MISSING",
            Self::NotRegularFile => "SCENE_RESOURCE_NOT_FILE",
            Self::UnsupportedResource | Self::InvalidSignature => "SCENE_RESOURCE_UNSUPPORTED",
            Self::TooManyResources | Self::TooManySessions => "SCENE_RESOURCE_LIMIT",
            Self::ResourceTooLarge | Self::RangeTooLarge | Self::SessionQuotaExceeded => {
                "SCENE_RESOURCE_TOO_LARGE"
            }
            Self::OverlappingRange => "SCENE_RESOURCE_OVERLAP",
            Self::ConcurrentLimit => "SCENE_RESOURCE_BUSY",
            Self::UnknownSession
            | Self::UnknownResource
            | Self::StaleGeneration
            | Self::RouteMismatch => "SCENE_RESOURCE_STALE",
            Self::Internal => "SCENE_RESOURCE_INTERNAL",
        }
    }
}
impl std::fmt::Display for ResourceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.code())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FileIdentity {
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
    #[cfg(windows)]
    volume_serial: u32,
    #[cfg(windows)]
    file_index: u64,
}

fn identity(file: &File) -> Result<FileIdentity, ResourceError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let m = file.metadata().map_err(|_| ResourceError::Internal)?;
        return Ok(FileIdentity {
            device: m.dev(),
            inode: m.ino(),
        });
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        };
        let mut i = unsafe { std::mem::zeroed::<BY_HANDLE_FILE_INFORMATION>() };
        if unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &mut i) } == 0 {
            return Err(ResourceError::Internal);
        }
        return Ok(FileIdentity {
            volume_serial: i.dwVolumeSerialNumber,
            file_index: (u64::from(i.nFileIndexHigh) << 32) | u64::from(i.nFileIndexLow),
        });
    }
    #[allow(unreachable_code)]
    Err(ResourceError::Internal)
}

fn is_reparse(metadata: &fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        return metadata.file_type().is_symlink();
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        return metadata.file_attributes() & 0x0400 != 0;
    }
    #[allow(unreachable_code)]
    false
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NormalizedRelative(String);
impl NormalizedRelative {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

pub fn normalize_relative(path: &Path) -> Result<NormalizedRelative, ResourceError> {
    if path.is_absolute()
        || path.components().any(|c| {
            matches!(
                c,
                Component::Prefix(_) | Component::RootDir | Component::ParentDir
            )
        })
    {
        return Err(ResourceError::InvalidRelativePath);
    }
    let mut parts = Vec::new();
    for c in path.components() {
        if let Component::Normal(p) = c {
            let s = p.to_str().ok_or(ResourceError::InvalidRelativePath)?;
            if s.is_empty() || s == "." || s.contains('\0') {
                return Err(ResourceError::InvalidRelativePath);
            }
            parts.push(s.to_owned());
        }
    }
    if parts.is_empty() {
        return Err(ResourceError::InvalidRelativePath);
    }
    Ok(NormalizedRelative(parts.join("\\")))
}

fn ext(relative: &NormalizedRelative) -> Option<&str> {
    relative.as_str().rsplit_once('.').map(|(_, e)| e)
}
fn allowed_extension(relative: &NormalizedRelative) -> bool {
    matches!(
        ext(relative).map(|s| s.to_ascii_lowercase()).as_deref(),
        Some(
            "glb"
                | "json"
                | "subtree"
                | "b3dm"
                | "i3dm"
                | "pnts"
                | "cmpt"
                | "bin"
                | "png"
                | "jpg"
                | "jpeg"
                | "webp"
        )
    )
}
fn mime_matches(relative: &NormalizedRelative, mime: Option<&str>) -> bool {
    let Some(mime) = mime else { return true };
    let m = mime.to_ascii_lowercase();
    match ext(relative).unwrap_or("").to_ascii_lowercase().as_str() {
        "glb" => m == "model/gltf-binary",
        "json" | "subtree" => m == "application/json" || m == "application/octet-stream",
        "b3dm" | "i3dm" | "pnts" | "cmpt" => m == "application/octet-stream",
        "bin" => m == "application/octet-stream" || m == "application/gltf-buffer",
        "png" => m == "image/png",
        "jpg" | "jpeg" => m == "image/jpeg",
        "webp" => m == "image/webp",
        _ => false,
    }
}
fn signature_ok(relative: &NormalizedRelative, bytes: &[u8]) -> bool {
    let e = ext(relative).unwrap_or("").to_ascii_lowercase();
    match e.as_str() {
        "glb" => bytes.starts_with(b"glTF"),
        "b3dm" => bytes.starts_with(b"b3dm"),
        "i3dm" => bytes.starts_with(b"i3dm"),
        "pnts" => bytes.starts_with(b"pnts"),
        "cmpt" => bytes.starts_with(b"cmpt"),
        "png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "jpg" | "jpeg" => bytes.starts_with(b"\xff\xd8\xff"),
        "webp" => bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP"),
        "json" | "subtree" => {
            serde_json::from_slice::<serde_json::Value>(bytes).is_ok()
                && !bytes.starts_with(b"<")
                && !bytes.windows(5).any(|w| w.eq_ignore_ascii_case(b"<html"))
        }
        "bin" => true,
        _ => false,
    }
}
fn reject_uri_json(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Object(map) => map.iter().any(|(k, v)| {
            (k.eq_ignore_ascii_case("uri") || k.to_ascii_lowercase().ends_with("uri"))
                && v.as_str().is_some_and(|s| !s.is_empty())
                || reject_uri_json(v)
        }),
        serde_json::Value::Array(a) => a.iter().any(reject_uri_json),
        _ => false,
    }
}

fn self_contained_glb_ok(bytes: &[u8]) -> bool {
    const JSON_CHUNK: u32 = 0x4e4f_534a;
    const BIN_CHUNK: u32 = 0x004e_4942;
    if bytes.len() < 20 || &bytes[..4] != b"glTF" {
        return false;
    }
    let version = u32::from_le_bytes(bytes[4..8].try_into().unwrap());
    let declared = u32::from_le_bytes(bytes[8..12].try_into().unwrap()) as usize;
    if version != 2 || declared != bytes.len() || declared % 4 != 0 {
        return false;
    }
    let mut offset = 12usize;
    let mut saw_json = false;
    let mut saw_bin = false;
    while offset < bytes.len() {
        let Some(header_end) = offset.checked_add(8) else {
            return false;
        };
        if header_end > bytes.len() {
            return false;
        }
        let length = u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap()) as usize;
        let kind = u32::from_le_bytes(bytes[offset + 4..header_end].try_into().unwrap());
        let Some(chunk_end) = header_end.checked_add(length) else {
            return false;
        };
        if length % 4 != 0 || chunk_end > bytes.len() {
            return false;
        }
        let chunk = &bytes[header_end..chunk_end];
        match kind {
            JSON_CHUNK if !saw_json && !saw_bin => {
                let end = chunk
                    .iter()
                    .rposition(|byte| !matches!(byte, b' ' | 0))
                    .map_or(0, |index| index + 1);
                let Ok(json) = serde_json::from_slice::<serde_json::Value>(&chunk[..end]) else {
                    return false;
                };
                if reject_uri_json(&json) {
                    return false;
                }
                saw_json = true;
            }
            BIN_CHUNK if saw_json && !saw_bin => saw_bin = true,
            _ => return false,
        }
        offset = chunk_end;
    }
    saw_json && offset == bytes.len()
}

#[cfg(not(windows))]
fn open_relative(root: &Root, relative: &NormalizedRelative) -> Result<File, ResourceError> {
    use std::os::unix::fs::OpenOptionsExt;
    let mut path = root.path.clone();
    for part in relative.as_str().split('\\') {
        path.push(part);
        let md = fs::symlink_metadata(&path).map_err(|_| ResourceError::Missing)?;
        if is_reparse(&md) {
            return Err(ResourceError::ReparsePoint);
        }
        if !md.is_dir() && part != relative.as_str().rsplit('\\').next().unwrap_or(part) {
            return Err(ResourceError::NotRegularFile);
        }
    }
    OpenOptions::new()
        .read(true)
        .custom_flags(0o400000)
        .open(path)
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                ResourceError::Missing
            } else {
                ResourceError::Internal
            }
        })
}

#[cfg(windows)]
fn nt_open_component(
    parent: &File,
    name_component: &str,
    directory: bool,
) -> Result<File, ResourceError> {
    use std::os::windows::io::{AsRawHandle, FromRawHandle};
    use windows_sys::Win32::Foundation::HANDLE;
    // NtCreateFile is the Windows handle-relative primitive: RootDirectory is the
    // retained picker directory handle, and OPEN_REPARSE_POINT prevents traversal.
    #[repr(C)]
    struct U {
        len: u16,
        max: u16,
        buf: *mut u16,
    }
    #[repr(C)]
    struct OA {
        len: u32,
        root: HANDLE,
        name: *mut U,
        attrs: u32,
        sd: *mut core::ffi::c_void,
        qos: *mut core::ffi::c_void,
    }
    #[repr(C)]
    struct IOS {
        status: i32,
        information: usize,
    }
    unsafe extern "system" {
        fn NtCreateFile(
            h: *mut HANDLE,
            access: u32,
            oa: *mut OA,
            ios: *mut IOS,
            alloc: *mut i64,
            attrs: u32,
            share: u32,
            disp: u32,
            opts: u32,
            ea: *mut core::ffi::c_void,
            ealen: u32,
        ) -> i32;
    }
    // With OBJECT_ATTRIBUTES.RootDirectory set, ObjectName must remain relative.
    // A leading backslash would make it absolute and bypass the retained root.
    debug_assert!(!name_component.contains('\\'));
    let mut wide: Vec<u16> = name_component.encode_utf16().collect();
    let mut name = U {
        len: (wide.len() * 2) as u16,
        max: (wide.len() * 2) as u16,
        buf: wide.as_mut_ptr(),
    };
    let mut oa = OA {
        len: std::mem::size_of::<OA>() as u32,
        root: parent.as_raw_handle() as HANDLE,
        name: &mut name,
        attrs: 0,
        sd: std::ptr::null_mut(),
        qos: std::ptr::null_mut(),
    };
    let mut out: HANDLE = std::ptr::null_mut();
    let mut ios = IOS {
        status: 0,
        information: 0,
    };
    let status = unsafe {
        NtCreateFile(
            &mut out,
            0x120089,
            &mut oa,
            &mut ios,
            std::ptr::null_mut(),
            0,
            7,
            1,
            // FILE_OPEN_REPARSE_POINT | FILE_DIRECTORY_FILE/FILE_NON_DIRECTORY_FILE |
            // FILE_SYNCHRONOUS_IO_NONALERT (required by std::fs::File I/O).
            0x200020 | if directory { 0x000001 } else { 0x000040 },
            std::ptr::null_mut(),
            0,
        )
    };
    if status < 0 {
        #[cfg(test)]
        eprintln!(
            "resource_session NtCreateFile status=0x{:08x}",
            status as u32
        );
        return Err(if status == 0xC0000034u32 as i32 {
            ResourceError::Missing
        } else {
            ResourceError::Internal
        });
    }
    let file = unsafe { File::from_raw_handle(out as _) };
    let metadata = file.metadata().map_err(|_| ResourceError::Internal)?;
    if is_reparse(&metadata) {
        return Err(ResourceError::ReparsePoint);
    }
    if (directory && !metadata.is_dir()) || (!directory && !metadata.is_file()) {
        return Err(ResourceError::NotRegularFile);
    }
    Ok(file)
}

#[cfg(windows)]
fn open_relative(root: &Root, relative: &NormalizedRelative) -> Result<File, ResourceError> {
    let components: Vec<&str> = relative.as_str().split('\\').collect();
    let mut opened_parent: Option<File> = None;
    for (index, component) in components.iter().enumerate() {
        let leaf = index + 1 == components.len();
        let parent = opened_parent.as_ref().unwrap_or(&root.handle);
        let opened = nt_open_component(parent, component, !leaf)?;
        if leaf {
            return Ok(opened);
        }
        opened_parent = Some(opened);
    }
    Err(ResourceError::InvalidRelativePath)
}

#[derive(Debug)]
struct Root {
    handle: File,
    identity: FileIdentity,
    #[cfg(not(windows))]
    path: std::path::PathBuf,
}

#[derive(Debug)]
pub(crate) struct RetainedRoot(Root);

impl RetainedRoot {
    pub(crate) fn capture(path: impl AsRef<Path>) -> Result<Self, ResourceError> {
        Root::capture(path).map(Self)
    }
}

impl Root {
    fn capture(path: impl AsRef<Path>) -> Result<Self, ResourceError> {
        let p = path.as_ref();
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;

            let mut components = p.components();
            let prefix = match components.next() {
                Some(Component::Prefix(prefix)) => prefix,
                _ => return Err(ResourceError::InvalidRoot),
            };
            if !matches!(components.next(), Some(Component::RootDir)) {
                return Err(ResourceError::InvalidRoot);
            }
            let mut anchor = std::path::PathBuf::from(prefix.as_os_str());
            anchor.push("\\");
            let mut handle = OpenOptions::new()
                .read(true)
                .custom_flags(0x0020_0000 | 0x0200_0000)
                .open(&anchor)
                .map_err(|_| ResourceError::InvalidRoot)?;
            let anchor_metadata = handle.metadata().map_err(|_| ResourceError::InvalidRoot)?;
            if !anchor_metadata.is_dir() || is_reparse(&anchor_metadata) {
                return Err(ResourceError::ReparsePoint);
            }
            for component in components {
                match component {
                    Component::Normal(name) => {
                        let name = name.to_str().ok_or(ResourceError::InvalidRoot)?;
                        handle = nt_open_component(&handle, name, true)?;
                    }
                    Component::CurDir => {}
                    _ => return Err(ResourceError::InvalidRoot),
                }
            }
            return Ok(Self {
                identity: identity(&handle)?,
                handle,
            });
        }
        #[cfg(not(windows))]
        {
            reject_reparse_ancestors(p)?;
            let md = fs::symlink_metadata(p).map_err(|_| ResourceError::InvalidRoot)?;
            if !md.is_dir() || is_reparse(&md) {
                return Err(if is_reparse(&md) {
                    ResourceError::ReparsePoint
                } else {
                    ResourceError::InvalidRoot
                });
            }
            let handle = OpenOptions::new()
                .read(true)
                .open(p)
                .map_err(|_| ResourceError::InvalidRoot)?;
            Ok(Self {
                identity: identity(&handle)?,
                handle,
                path: p.to_path_buf(),
            })
        }
    }
    fn verify(&self) -> Result<(), ResourceError> {
        if identity(&self.handle)? != self.identity {
            Err(ResourceError::InvalidRoot)
        } else {
            Ok(())
        }
    }
}

fn reject_reparse_ancestors(path: &Path) -> Result<(), ResourceError> {
    let mut current = std::path::PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => current.push(prefix.as_os_str()),
            Component::RootDir => current.push(std::path::MAIN_SEPARATOR.to_string()),
            Component::Normal(name) => {
                current.push(name);
                let md = fs::symlink_metadata(&current).map_err(|_| ResourceError::InvalidRoot)?;
                if is_reparse(&md) {
                    return Err(ResourceError::ReparsePoint);
                }
            }
            Component::CurDir => {}
            Component::ParentDir => return Err(ResourceError::InvalidRoot),
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct SessionId([u8; 16]);
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ResourceId([u8; 16]);
fn random_id<T: From<[u8; 16]>>() -> Result<T, ResourceError> {
    let mut b = [0; 16];
    getrandom::fill(&mut b).map_err(|_| ResourceError::Internal)?;
    Ok(T::from(b))
}
impl From<[u8; 16]> for SessionId {
    fn from(v: [u8; 16]) -> Self {
        Self(v)
    }
}
impl From<[u8; 16]> for ResourceId {
    fn from(v: [u8; 16]) -> Self {
        Self(v)
    }
}

fn opaque_bytes(bytes: &[u8; 16]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn parse_opaque(value: &str) -> Option<[u8; 16]> {
    if value.len() != 32
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return None;
    }
    let mut out = [0u8; 16];
    for (index, slot) in out.iter_mut().enumerate() {
        *slot = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16).ok()?;
    }
    Some(out)
}
impl SessionId {
    pub fn opaque(self) -> String {
        opaque_bytes(&self.0)
    }
    pub fn from_opaque(value: &str) -> Result<Self, ResourceError> {
        parse_opaque(value)
            .map(Self)
            .ok_or(ResourceError::UnknownSession)
    }
}
impl ResourceId {
    pub fn opaque(self) -> String {
        opaque_bytes(&self.0)
    }
    pub fn from_opaque(value: &str) -> Result<Self, ResourceError> {
        parse_opaque(value)
            .map(Self)
            .ok_or(ResourceError::UnknownResource)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionBinding {
    pub generation: u64,
    pub route: String,
    owner: Option<String>,
}
#[derive(Debug)]
struct Resource {
    handle: File,
    identity: FileIdentity,
    size: u64,
    relative: String,
    mime: &'static str,
    ranges: Vec<(u64, u64)>,
}
#[derive(Debug)]
struct Session {
    root: Root,
    binding: SessionBinding,
    resources: HashMap<ResourceId, Resource>,
    committed: u64,
    reserved: u64,
    concurrent: usize,
}
#[derive(Default)]
pub struct ResourceSessionRegistry {
    sessions: Mutex<HashMap<SessionId, Session>>,
}
#[derive(Debug, PartialEq, Eq)]
pub struct ResourceRead {
    pub id: ResourceId,
    pub bytes: Vec<u8>,
}

#[derive(Debug, PartialEq, Eq)]
pub struct RegisteredResource {
    pub session: SessionId,
    pub resource: ResourceId,
    pub size: u64,
    pub mime: &'static str,
}

fn read_exact_at(file: &File, offset: u64, length: u64) -> Result<Vec<u8>, ResourceError> {
    let length = usize::try_from(length).map_err(|_| ResourceError::RangeTooLarge)?;
    let mut bytes = vec![0u8; length];
    let mut read = 0usize;
    while read < length {
        #[cfg(windows)]
        let count = {
            use std::os::windows::fs::FileExt;
            file.seek_read(&mut bytes[read..], offset + read as u64)
        };
        #[cfg(unix)]
        let count = {
            use std::os::unix::fs::FileExt;
            file.read_at(&mut bytes[read..], offset + read as u64)
        };
        let count = count.map_err(|_| ResourceError::Internal)?;
        if count == 0 {
            return Err(ResourceError::Internal);
        }
        read += count;
    }
    Ok(bytes)
}

impl ResourceSessionRegistry {
    pub fn create(&self, root: impl AsRef<Path>) -> Result<SessionId, ResourceError> {
        self.create_bound(root, 0, "scene-preset")
    }
    pub fn create_bound(
        &self,
        root: impl AsRef<Path>,
        generation: u64,
        route: impl Into<String>,
    ) -> Result<SessionId, ResourceError> {
        self.create_bound_owner(root, generation, route, None)
    }
    pub fn create_bound_owner(
        &self,
        root: impl AsRef<Path>,
        generation: u64,
        route: impl Into<String>,
        owner: Option<String>,
    ) -> Result<SessionId, ResourceError> {
        self.create_bound_owner_retained(RetainedRoot::capture(root)?, generation, route, owner)
    }
    pub(crate) fn create_bound_owner_retained(
        &self,
        root: RetainedRoot,
        generation: u64,
        route: impl Into<String>,
        owner: Option<String>,
    ) -> Result<SessionId, ResourceError> {
        let id = random_id()?;
        let state = Session {
            root: root.0,
            binding: SessionBinding {
                generation,
                route: route.into(),
                owner,
            },
            resources: HashMap::new(),
            committed: 0,
            reserved: 0,
            concurrent: 0,
        };
        let mut sessions = self.sessions.lock().map_err(|_| ResourceError::Internal)?;
        if sessions.len() >= MAX_SESSIONS {
            return Err(ResourceError::TooManySessions);
        }
        sessions.insert(id, state);
        Ok(id)
    }
    fn check_binding(s: &Session, generation: u64, route: &str) -> Result<(), ResourceError> {
        if s.binding.route != route {
            return Err(ResourceError::RouteMismatch);
        }
        if s.binding.generation != generation {
            return Err(ResourceError::StaleGeneration);
        }
        Ok(())
    }
    pub fn register_and_read(
        &self,
        session: SessionId,
        relative: &Path,
        range: Option<(u64, u64)>,
    ) -> Result<ResourceRead, ResourceError> {
        self.register_and_read_bound(session, 0, "scene-preset", relative, None, range)
    }
    pub fn register_and_read_bound(
        &self,
        session: SessionId,
        generation: u64,
        route: &str,
        relative: &Path,
        mime: Option<&str>,
        range: Option<(u64, u64)>,
    ) -> Result<ResourceRead, ResourceError> {
        let normalized = normalize_relative(relative)?;
        if !allowed_extension(&normalized) || !mime_matches(&normalized, mime) {
            return Err(ResourceError::UnsupportedResource);
        }
        let mut all = self.sessions.lock().map_err(|_| ResourceError::Internal)?;
        let s = all.get_mut(&session).ok_or(ResourceError::UnknownSession)?;
        Self::check_binding(s, generation, route)?;
        s.root.verify()?;
        if s.concurrent >= MAX_CONCURRENT {
            return Err(ResourceError::ConcurrentLimit);
        }
        let key = s
            .resources
            .iter()
            .find(|(_, r)| r.relative == normalized.as_str())
            .map(|(&id, _)| id)
            .unwrap_or(random_id()?);
        let mut resource = if let Some(r) = s.resources.remove(&key) {
            r
        } else {
            if s.resources.len() >= MAX_RESOURCES {
                return Err(ResourceError::TooManyResources);
            }
            let handle = open_relative(&s.root, &normalized)?;
            let md = handle.metadata().map_err(|_| ResourceError::Internal)?;
            if !md.is_file() || is_reparse(&md) {
                return Err(if is_reparse(&md) {
                    ResourceError::ReparsePoint
                } else {
                    ResourceError::NotRegularFile
                });
            }
            if md.len() > MAX_RESOURCE_BYTES {
                return Err(ResourceError::ResourceTooLarge);
            }
            Resource {
                identity: identity(&handle)?,
                size: md.len(),
                relative: normalized.as_str().to_owned(),
                mime: match ext(&normalized) {
                    Some("glb") => "model/gltf-binary",
                    Some("json") => "application/json",
                    _ => "application/octet-stream",
                },
                handle,
                ranges: Vec::new(),
            }
        };
        let (offset, length) = range.unwrap_or((0, resource.size));
        if offset > resource.size || length > resource.size - offset {
            return Err(ResourceError::InvalidRange);
        }
        if length > MAX_RANGE_BYTES {
            return Err(ResourceError::RangeTooLarge);
        }
        let end = offset
            .checked_add(length)
            .ok_or(ResourceError::InvalidRange)?;
        if resource.ranges.iter().any(|&(a, b)| offset < b && a < end) {
            return Err(ResourceError::OverlappingRange);
        }
        if s.committed
            .checked_add(s.reserved)
            .and_then(|n| n.checked_add(length))
            .is_none_or(|n| n > MAX_SESSION_BYTES)
        {
            return Err(ResourceError::SessionQuotaExceeded);
        }
        s.reserved += length;
        s.concurrent += 1;
        resource.ranges.push((offset, end));
        let result = (|| {
            resource
                .handle
                .seek(SeekFrom::Start(offset))
                .map_err(|_| ResourceError::Internal)?;
            let mut bytes = Vec::with_capacity(length as usize);
            resource
                .handle
                .by_ref()
                .take(length)
                .read_to_end(&mut bytes)
                .map_err(|_| ResourceError::Internal)?;
            if bytes.len() as u64 != length || identity(&resource.handle)? != resource.identity {
                return Err(ResourceError::Internal);
            };
            if !signature_ok(&normalized, &bytes) {
                return Err(ResourceError::InvalidSignature);
            };
            if matches!(ext(&normalized), Some("json") | Some("subtree")) {
                let v: serde_json::Value =
                    serde_json::from_slice(&bytes).map_err(|_| ResourceError::InvalidSignature)?;
                if reject_uri_json(&v) {
                    return Err(ResourceError::InvalidSignature);
                }
            };
            Ok(ResourceRead {
                id: random_id()?,
                bytes,
            })
        })();
        s.reserved -= length;
        s.concurrent -= 1;
        if result.is_ok() {
            s.committed += length;
        } else {
            resource.ranges.pop();
        }
        if let Ok(read) = &result {
            s.resources.insert(read.id, resource);
        }
        result
    }
    pub fn register_self_contained_glb_bound(
        &self,
        session: SessionId,
        generation: u64,
        route: &str,
        relative: &Path,
    ) -> Result<RegisteredResource, ResourceError> {
        let normalized = normalize_relative(relative)?;
        if ext(&normalized) != Some("glb") {
            return Err(ResourceError::UnsupportedResource);
        }
        let (resource_id, handle, file_identity, size) = {
            let mut all = self.sessions.lock().map_err(|_| ResourceError::Internal)?;
            let s = all.get_mut(&session).ok_or(ResourceError::UnknownSession)?;
            Self::check_binding(s, generation, route)?;
            s.root.verify()?;
            if let Some((&resource, existing)) = s
                .resources
                .iter()
                .find(|(_, resource)| resource.relative == normalized.as_str())
            {
                return Ok(RegisteredResource {
                    session,
                    resource,
                    size: existing.size,
                    mime: existing.mime,
                });
            }
            if s.resources.len() >= MAX_RESOURCES {
                return Err(ResourceError::TooManyResources);
            }
            if s.concurrent >= MAX_CONCURRENT {
                return Err(ResourceError::ConcurrentLimit);
            }
            let handle = open_relative(&s.root, &normalized)?;
            let metadata = handle.metadata().map_err(|_| ResourceError::Internal)?;
            let size = metadata.len();
            if size > MAX_RESOURCE_BYTES || size > MAX_RANGE_BYTES {
                return Err(ResourceError::ResourceTooLarge);
            }
            if s.committed
                .checked_add(s.reserved)
                .and_then(|bytes| bytes.checked_add(size))
                .is_none_or(|bytes| bytes > MAX_SESSION_BYTES)
            {
                return Err(ResourceError::SessionQuotaExceeded);
            }
            let file_identity = identity(&handle)?;
            let resource = random_id()?;
            s.reserved += size;
            s.concurrent += 1;
            (resource, handle, file_identity, size)
        };

        let bytes = read_exact_at(&handle, 0, size);
        let validation = bytes.and_then(|bytes| {
            if identity(&handle)? != file_identity || !self_contained_glb_ok(&bytes) {
                return Err(ResourceError::InvalidSignature);
            }
            Ok(())
        });

        let mut all = self.sessions.lock().map_err(|_| ResourceError::Internal)?;
        let Some(s) = all.get_mut(&session) else {
            return Err(ResourceError::StaleGeneration);
        };
        s.reserved = s.reserved.saturating_sub(size);
        s.concurrent = s.concurrent.saturating_sub(1);
        Self::check_binding(s, generation, route)?;
        validation?;
        s.committed += size;
        s.resources.insert(
            resource_id,
            Resource {
                handle,
                identity: file_identity,
                size,
                relative: normalized.as_str().to_owned(),
                mime: "model/gltf-binary",
                ranges: Vec::new(),
            },
        );
        Ok(RegisteredResource {
            session,
            resource: resource_id,
            size,
            mime: "model/gltf-binary",
        })
    }

    pub fn read_registered_bound(
        &self,
        session: SessionId,
        resource_id: ResourceId,
        generation: u64,
        route: &str,
        range: Option<(u64, u64)>,
    ) -> Result<ResourceRead, ResourceError> {
        let (handle, expected_identity, offset, length, end) = {
            let mut all = self.sessions.lock().map_err(|_| ResourceError::Internal)?;
            let s = all.get_mut(&session).ok_or(ResourceError::UnknownSession)?;
            Self::check_binding(s, generation, route)?;
            s.root.verify()?;
            if s.concurrent >= MAX_CONCURRENT {
                return Err(ResourceError::ConcurrentLimit);
            }
            let resource = s
                .resources
                .get_mut(&resource_id)
                .ok_or(ResourceError::UnknownResource)?;
            let (offset, length) = range.unwrap_or((0, resource.size));
            if offset > resource.size || length > resource.size - offset {
                return Err(ResourceError::InvalidRange);
            }
            if length > MAX_RANGE_BYTES {
                return Err(ResourceError::RangeTooLarge);
            }
            let end = offset
                .checked_add(length)
                .ok_or(ResourceError::InvalidRange)?;
            if resource
                .ranges
                .iter()
                .any(|&(start, stop)| offset < stop && start < end)
            {
                return Err(ResourceError::OverlappingRange);
            }
            if s.committed
                .checked_add(s.reserved)
                .and_then(|bytes| bytes.checked_add(length))
                .is_none_or(|bytes| bytes > MAX_SESSION_BYTES)
            {
                return Err(ResourceError::SessionQuotaExceeded);
            }
            let handle = resource
                .handle
                .try_clone()
                .map_err(|_| ResourceError::Internal)?;
            resource.ranges.push((offset, end));
            s.reserved += length;
            s.concurrent += 1;
            (handle, resource.identity, offset, length, end)
        };

        let result = read_exact_at(&handle, offset, length).and_then(|bytes| {
            if identity(&handle)? != expected_identity {
                return Err(ResourceError::Internal);
            }
            Ok(ResourceRead {
                id: resource_id,
                bytes,
            })
        });

        let mut all = self.sessions.lock().map_err(|_| ResourceError::Internal)?;
        let Some(s) = all.get_mut(&session) else {
            return Err(ResourceError::StaleGeneration);
        };
        s.reserved = s.reserved.saturating_sub(length);
        s.concurrent = s.concurrent.saturating_sub(1);
        if Self::check_binding(s, generation, route).is_err() {
            return Err(ResourceError::StaleGeneration);
        }
        if let Some(resource) = s.resources.get_mut(&resource_id) {
            if let Some(index) = resource
                .ranges
                .iter()
                .position(|&(start, stop)| start == offset && stop == end)
            {
                resource.ranges.remove(index);
            }
        }
        if result.is_ok() {
            s.committed += length;
        }
        result
    }

    pub fn metadata_bound(
        &self,
        session: SessionId,
        resource: ResourceId,
        generation: u64,
        route: &str,
    ) -> Result<(u64, &'static str), ResourceError> {
        let all = self.sessions.lock().map_err(|_| ResourceError::Internal)?;
        let state = all.get(&session).ok_or(ResourceError::UnknownSession)?;
        Self::check_binding(state, generation, route)?;
        let resource = state
            .resources
            .get(&resource)
            .ok_or(ResourceError::UnknownResource)?;
        Ok((resource.size, resource.mime))
    }

    pub fn close(&self, session: SessionId) -> Result<(), ResourceError> {
        self.sessions
            .lock()
            .map_err(|_| ResourceError::Internal)?
            .remove(&session)
            .map(|_| ())
            .ok_or(ResourceError::UnknownSession)
    }
    pub fn close_idempotent(&self, session: SessionId) {
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.remove(&session);
        }
    }
    pub fn close_owner(&self, owner: &str) {
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.retain(|_, session| session.binding.owner.as_deref() != Some(owner));
        }
    }
    pub fn session_count(&self) -> usize {
        self.sessions.lock().map(|s| s.len()).unwrap_or(0)
    }
}

const RESOURCE_ROUTE: &str = "preset-import";
const WEBVIEW_ORIGIN: &str = "http://tauri.localhost";

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedRelativeResource {
    pub url: String,
}

fn public_error(error: ResourceError) -> String {
    match error {
        ResourceError::ResourceTooLarge
        | ResourceError::RangeTooLarge
        | ResourceError::SessionQuotaExceeded
        | ResourceError::TooManyResources
        | ResourceError::TooManySessions
        | ResourceError::ConcurrentLimit => "SCENE_PRESET_LIMIT_EXCEEDED",
        ResourceError::UnknownSession
        | ResourceError::UnknownResource
        | ResourceError::StaleGeneration
        | ResourceError::RouteMismatch => "SCENE_PRESET_SESSION_STALE",
        ResourceError::Missing => "SCENE_PRESET_REFERENCE_MISSING",
        ResourceError::InvalidRelativePath
        | ResourceError::InvalidRoot
        | ResourceError::ReparsePoint
        | ResourceError::NotRegularFile
        | ResourceError::UnsupportedResource
        | ResourceError::InvalidSignature
        | ResourceError::InvalidRange
        | ResourceError::OverlappingRange => "SCENE_PRESET_REFERENCE_INVALID",
        ResourceError::Internal => "SCENE_PRESET_INTERNAL",
    }
    .to_string()
}

#[tauri::command]
pub fn prepare_relative_scene_resource(
    file_state: tauri::State<'_, crate::scene_preset_file::ScenePresetTransportState>,
    registry: tauri::State<'_, Arc<ResourceSessionRegistry>>,
    import_capability: String,
    generation: u64,
    relative_reference: String,
) -> Result<PreparedRelativeResource, String> {
    let session = file_state.import_resource_session(
        &import_capability,
        generation,
        &relative_reference,
        |root| {
            registry
                .create_bound_owner_retained(
                    root,
                    generation,
                    RESOURCE_ROUTE,
                    Some(import_capability.clone()),
                )
                .map_err(public_error)
        },
    )?;
    registry
        .register_self_contained_glb_bound(
            session,
            generation,
            RESOURCE_ROUTE,
            Path::new(&relative_reference),
        )
        .map(|registered| PreparedRelativeResource {
            url: protocol_url(&registered, generation),
        })
        .map_err(public_error)
}

pub fn protocol_url(registered: &RegisteredResource, generation: u64) -> String {
    #[cfg(windows)]
    let origin = "http://geoim3d-preset-resource.localhost";
    #[cfg(not(windows))]
    let origin = "geoim3d-preset-resource://localhost";
    format!(
        "{origin}/v1/{}/{}/{generation}",
        registered.session.opaque(),
        registered.resource.opaque()
    )
}

fn parse_protocol_path(path: &str) -> Result<(SessionId, ResourceId, u64), ResourceError> {
    let parts: Vec<&str> = path.split('/').collect();
    if parts.len() != 5 || parts[0] != "" || parts[1] != "v1" {
        return Err(ResourceError::InvalidRelativePath);
    }
    let generation = parts[4]
        .parse::<u64>()
        .map_err(|_| ResourceError::StaleGeneration)?;
    if generation.to_string() != parts[4] {
        return Err(ResourceError::StaleGeneration);
    }
    Ok((
        SessionId::from_opaque(parts[2])?,
        ResourceId::from_opaque(parts[3])?,
        generation,
    ))
}

fn parse_range(value: Option<&str>, size: u64) -> Result<Option<(u64, u64)>, ResourceError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let value = value
        .strip_prefix("bytes=")
        .ok_or(ResourceError::InvalidRange)?;
    if value.contains(',') {
        return Err(ResourceError::InvalidRange);
    }
    let (start, end) = value.split_once('-').ok_or(ResourceError::InvalidRange)?;
    if start.is_empty() {
        return Err(ResourceError::InvalidRange);
    }
    let start = start
        .parse::<u64>()
        .map_err(|_| ResourceError::InvalidRange)?;
    let end = if end.is_empty() {
        size.checked_sub(1).ok_or(ResourceError::InvalidRange)?
    } else {
        end.parse::<u64>()
            .map_err(|_| ResourceError::InvalidRange)?
    };
    if start > end || end >= size {
        return Err(ResourceError::InvalidRange);
    }
    Ok(Some((start, end - start + 1)))
}

fn protocol_error(status: tauri::http::StatusCode) -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(status)
        .header("Cache-Control", "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .header("Access-Control-Allow-Origin", WEBVIEW_ORIGIN)
        .header("Vary", "Origin")
        .body(Vec::new())
        .unwrap_or_else(|_| tauri::http::Response::new(Vec::new()))
}

pub fn protocol_response(
    registry: &ResourceSessionRegistry,
    request: &tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    use tauri::http::{header, Method, StatusCode};
    let is_head = request.method() == Method::HEAD;
    if (request.method() != Method::GET && !is_head) || request.uri().query().is_some() {
        return protocol_error(StatusCode::BAD_REQUEST);
    }
    let Ok((session, resource, generation)) = parse_protocol_path(request.uri().path()) else {
        return protocol_error(StatusCode::BAD_REQUEST);
    };
    let Ok((size, mime)) = registry.metadata_bound(session, resource, generation, RESOURCE_ROUTE)
    else {
        return protocol_error(StatusCode::NOT_FOUND);
    };
    let range_header = request
        .headers()
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok());
    let Ok(range) = parse_range(range_header, size) else {
        return protocol_error(StatusCode::RANGE_NOT_SATISFIABLE);
    };
    let requested_length = range.map_or(size, |(_, length)| length);
    let bytes = if is_head {
        Vec::new()
    } else {
        let Ok(read) =
            registry.read_registered_bound(session, resource, generation, RESOURCE_ROUTE, range)
        else {
            return protocol_error(StatusCode::NOT_FOUND);
        };
        read.bytes
    };
    let (status, offset) = match range {
        Some((offset, _)) => (StatusCode::PARTIAL_CONTENT, offset),
        None => (StatusCode::OK, 0),
    };
    let mut builder = tauri::http::Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, mime)
        .header(header::CONTENT_LENGTH, requested_length.to_string())
        .header(header::ACCEPT_RANGES, "bytes")
        .header("Cache-Control", "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .header("Access-Control-Allow-Origin", WEBVIEW_ORIGIN)
        .header(
            "Access-Control-Expose-Headers",
            "Accept-Ranges, Content-Length, Content-Range, X-Content-Type-Options",
        )
        .header("Vary", "Origin");
    if let Some((_, length)) = range {
        builder = builder.header(
            header::CONTENT_RANGE,
            format!("bytes {offset}-{}/{size}", offset + length - 1),
        );
    }
    builder
        .body(bytes)
        .unwrap_or_else(|_| protocol_error(StatusCode::INTERNAL_SERVER_ERROR))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    fn dir() -> PathBuf {
        let mut random = [0u8; 8];
        getrandom::fill(&mut random).unwrap();
        let suffix = u64::from_le_bytes(random);
        let p = std::env::temp_dir().join(format!(
            "geoim3d-resource-{}-{suffix:x}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }
    #[test]
    fn paths_are_normalized_and_capabilities_opaque() {
        assert_eq!(
            normalize_relative(Path::new("a/./b.glb")).unwrap().as_str(),
            "a\\b.glb"
        );
        assert_eq!(
            normalize_relative(Path::new("../x.glb")),
            Err(ResourceError::InvalidRelativePath)
        );
        assert_eq!(
            normalize_relative(Path::new("/x.glb")),
            Err(ResourceError::InvalidRelativePath)
        );
        let session = SessionId([0xab; 16]);
        let encoded = session.opaque();
        assert_eq!(encoded, "abababababababababababababababab");
        assert_eq!(SessionId::from_opaque(&encoded), Ok(session));
        assert_eq!(
            SessionId::from_opaque("ABABABABABABABABABABABABABABABAB"),
            Err(ResourceError::UnknownSession)
        );
    }

    #[cfg(windows)]
    #[test]
    fn retained_root_captures_windows_unc_worktree_component_by_component() {
        let current = std::env::current_dir().unwrap();
        assert!(current.to_string_lossy().starts_with(r"\\"));
        let root = RetainedRoot::capture(&current).unwrap();
        root.0.verify().unwrap();
    }

    #[test]
    fn registry_enforces_global_session_ceiling() {
        let root = dir();
        let registry = ResourceSessionRegistry::default();
        let mut sessions = Vec::new();
        for _ in 0..MAX_SESSIONS {
            sessions.push(registry.create(&root).unwrap());
        }
        assert_eq!(registry.session_count(), MAX_SESSIONS);
        assert_eq!(registry.create(&root), Err(ResourceError::TooManySessions));
        for session in sessions {
            registry.close_idempotent(session);
        }
        let _ = fs::remove_dir_all(root);
    }

    fn glb(json: &str) -> Vec<u8> {
        let mut json = json.as_bytes().to_vec();
        while json.len() % 4 != 0 {
            json.push(b' ');
        }
        let total = 12 + 8 + json.len();
        let mut bytes = Vec::with_capacity(total);
        bytes.extend_from_slice(b"glTF");
        bytes.extend_from_slice(&2u32.to_le_bytes());
        bytes.extend_from_slice(&(total as u32).to_le_bytes());
        bytes.extend_from_slice(&(json.len() as u32).to_le_bytes());
        bytes.extend_from_slice(&0x4e4f_534au32.to_le_bytes());
        bytes.extend_from_slice(&json);
        bytes
    }

    #[test]
    fn self_contained_glb_validation_rejects_external_uris_and_malformed_chunks() {
        assert!(self_contained_glb_ok(&glb(
            r#"{"asset":{"version":"2.0"}}"#
        )));
        assert!(!self_contained_glb_ok(&glb(
            r#"{"asset":{"version":"2.0"},"buffers":[{"uri":"payload.bin"}]}"#
        )));
        let mut wrong_length = glb(r#"{"asset":{"version":"2.0"}}"#);
        wrong_length[8..12].copy_from_slice(&12u32.to_le_bytes());
        assert!(!self_contained_glb_ok(&wrong_length));
        assert!(!self_contained_glb_ok(b"glTFpayload"));
    }

    #[test]
    fn registers_self_contained_glb_then_reads_stable_opaque_ranges() {
        let p = dir();
        fs::create_dir_all(p.join("models")).unwrap();
        fs::write(
            p.join("models").join("model.glb"),
            glb(r#"{"asset":{"version":"2.0"}}"#),
        )
        .unwrap();
        fs::write(
            p.join("models").join("external.glb"),
            glb(r#"{"asset":{"version":"2.0"},"buffers":[{"uri":"x.bin"}]}"#),
        )
        .unwrap();
        let registry = ResourceSessionRegistry::default();
        let session = registry.create_bound(&p, 9, "preset-import").unwrap();
        let registered = registry
            .register_self_contained_glb_bound(
                session,
                9,
                "preset-import",
                Path::new("models/model.glb"),
            )
            .unwrap();
        let read = registry
            .read_registered_bound(
                session,
                registered.resource,
                9,
                "preset-import",
                Some((0, 4)),
            )
            .unwrap();
        assert_eq!(read.id, registered.resource);
        assert_eq!(read.bytes, b"glTF");
        assert_eq!(
            registry
                .read_registered_bound(
                    session,
                    registered.resource,
                    9,
                    "preset-import",
                    Some((0, 4)),
                )
                .unwrap()
                .bytes,
            b"glTF"
        );
        assert_eq!(
            registry.register_self_contained_glb_bound(
                session,
                9,
                "preset-import",
                Path::new("models/external.glb"),
            ),
            Err(ResourceError::InvalidSignature)
        );
        fs::remove_dir_all(p).unwrap();
    }

    #[test]
    fn protocol_serves_only_opaque_strict_single_ranges() {
        use tauri::http::{header, Method, Request, StatusCode};
        let p = dir();
        fs::write(p.join("model.glb"), glb(r#"{"asset":{"version":"2.0"}}"#)).unwrap();
        let registry = ResourceSessionRegistry::default();
        let session = registry.create_bound(&p, 11, RESOURCE_ROUTE).unwrap();
        let registered = registry
            .register_self_contained_glb_bound(session, 11, RESOURCE_ROUTE, Path::new("model.glb"))
            .unwrap();
        let url = protocol_url(&registered, 11);
        assert!(!url.contains("model.glb"));
        assert!(!url.contains(&p.to_string_lossy().to_string()));
        let head_request = Request::builder()
            .method(Method::HEAD)
            .uri(&url)
            .header(header::RANGE, "bytes=0-3")
            .body(Vec::new())
            .unwrap();
        let head_response = protocol_response(&registry, &head_request);
        assert_eq!(head_response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(head_response.headers()[header::CONTENT_LENGTH], "4");
        assert!(head_response.body().is_empty());

        let request = Request::builder()
            .method(Method::GET)
            .uri(&url)
            .header(header::RANGE, "bytes=0-3")
            .body(Vec::new())
            .unwrap();
        let response = protocol_response(&registry, &request);
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.body(), b"glTF");
        assert_eq!(
            response.headers()[header::CONTENT_TYPE],
            "model/gltf-binary"
        );
        assert_eq!(response.headers()[header::CONTENT_RANGE], "bytes 0-3/48");
        assert_eq!(response.headers()["X-Content-Type-Options"], "nosniff");
        assert_eq!(
            response.headers()["Access-Control-Allow-Origin"],
            WEBVIEW_ORIGIN
        );
        assert_eq!(response.headers()["Vary"], "Origin");
        assert_eq!(
            response.headers()["Access-Control-Expose-Headers"],
            "Accept-Ranges, Content-Length, Content-Range, X-Content-Type-Options"
        );
        assert!(!response
            .headers()
            .contains_key("Access-Control-Allow-Credentials"));

        let full_request = Request::builder()
            .method(Method::GET)
            .uri(&url)
            .body(Vec::new())
            .unwrap();
        assert_eq!(
            protocol_response(&registry, &full_request).status(),
            StatusCode::OK
        );
        assert_eq!(
            protocol_response(&registry, &request).status(),
            StatusCode::PARTIAL_CONTENT
        );

        let malformed = Request::builder()
            .method(Method::POST)
            .uri(&url)
            .body(Vec::new())
            .unwrap();
        assert_eq!(
            protocol_response(&registry, &malformed).status(),
            StatusCode::BAD_REQUEST
        );
        fs::remove_dir_all(p).unwrap();
    }

    #[test]
    fn allowed_signatures_and_handle_backed_read() {
        let p = dir();
        fs::create_dir_all(p.join("models")).unwrap();
        fs::write(p.join("models").join("model.glb"), b"glTFpayload").unwrap();
        let r = ResourceSessionRegistry::default();
        let s = r.create_bound(&p, 7, "preset-import").unwrap();
        let x = r
            .register_and_read_bound(
                s,
                7,
                "preset-import",
                Path::new("models/model.glb"),
                Some("model/gltf-binary"),
                Some((0, 4)),
            )
            .unwrap();
        assert_eq!(x.bytes, b"glTF");
        assert_eq!(
            r.register_and_read_bound(
                s,
                8,
                "preset-import",
                Path::new("models/model.glb"),
                None,
                Some((4, 1))
            ),
            Err(ResourceError::StaleGeneration)
        );
        r.close_idempotent(s);
        r.close_idempotent(s);
        fs::remove_dir_all(p).unwrap();
    }
    #[test]
    fn rejects_bad_mime_signature_overlap_and_range() {
        let p = dir();
        fs::write(p.join("x.glb"), b"not-glb").unwrap();
        let r = ResourceSessionRegistry::default();
        let s = r.create(&p).unwrap();
        assert_eq!(
            r.register_and_read_bound(
                s,
                0,
                "scene-preset",
                Path::new("x.glb"),
                Some("text/plain"),
                None
            ),
            Err(ResourceError::UnsupportedResource)
        );
        assert_eq!(
            r.register_and_read_bound(s, 0, "scene-preset", Path::new("x.glb"), None, Some((0, 4))),
            Err(ResourceError::InvalidSignature)
        );
        fs::write(p.join("x.glb"), b"glTF1234").unwrap();
        let _ =
            r.register_and_read_bound(s, 0, "scene-preset", Path::new("x.glb"), None, Some((0, 4)));
        assert_eq!(
            r.register_and_read_bound(s, 0, "scene-preset", Path::new("x.glb"), None, Some((0, 4))),
            Err(ResourceError::OverlappingRange)
        );
        fs::remove_dir_all(p).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn rejects_symlink_root_and_leaf() {
        use std::os::unix::fs::symlink;
        let p = dir();
        let target = dir();
        fs::write(target.join("x.glb"), b"glTF").unwrap();
        symlink(&target, p.join("link")).unwrap();
        assert_eq!(
            Root::capture(p.join("link")).unwrap_err().to_string(),
            ResourceError::ReparsePoint.code()
        );
        symlink(target.join("x.glb"), p.join("x.glb")).unwrap();
        let r = ResourceSessionRegistry::default();
        let s = r.create(&p).unwrap();
        assert_eq!(
            r.register_and_read(s, Path::new("x.glb"), None),
            Err(ResourceError::ReparsePoint)
        );
        let _ = fs::remove_dir_all(p);
        let _ = fs::remove_dir_all(target);
    }
}
