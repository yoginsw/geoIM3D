use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

const MAX_BYTES: usize = 8 * 1024 * 1024;
const SUFFIX: &str = ".geoim3d-preset.json";
const FILTER_EXTENSION: &str = "geoim3d-preset.json";
const INVALID: &str = "SCENE_PRESET_INVALID";
const TOO_LARGE: &str = "SCENE_PRESET_TOO_LARGE";
const WRITE_FAILED: &str = "SCENE_PRESET_WRITE_FAILED";
const CANCELLED: &str = "SCENE_PRESET_CANCELLED";
const INTERNAL: &str = "SCENE_PRESET_INTERNAL";

#[derive(Default)]
pub struct ScenePresetTransportState {
    sessions: Mutex<HashMap<String, Session>>,
}

enum Session {
    // Native-only root for resolving allowlisted relative model resources. This
    // path is never serialized or returned to the WebView.
    Import {
        root: Option<crate::resource_session::RetainedRoot>,
        allowed_relative_references: HashSet<String>,
        generation: Option<u64>,
        resource_session: Option<crate::resource_session::SessionId>,
    },
    Save(PathBuf),
}

impl ScenePresetTransportState {
    pub(crate) fn import_resource_session<F>(
        &self,
        capability: &str,
        generation: u64,
        relative_reference: &str,
        create: F,
    ) -> Result<crate::resource_session::SessionId, String>
    where
        F: FnOnce(
            crate::resource_session::RetainedRoot,
        ) -> Result<crate::resource_session::SessionId, String>,
    {
        let mut sessions = self.sessions.lock().map_err(|_| INTERNAL.to_string())?;
        match sessions.get_mut(capability) {
            Some(Session::Import {
                root,
                allowed_relative_references,
                generation: bound_generation,
                resource_session,
            }) => {
                if !allowed_relative_references.contains(relative_reference) {
                    return Err(INVALID.to_string());
                }
                if bound_generation.is_some_and(|bound| bound != generation) {
                    return Err(INVALID.to_string());
                }
                if let Some(session) = resource_session {
                    return Ok(*session);
                }
                let retained_root = root.take().ok_or_else(|| INVALID.to_string())?;
                let session = create(retained_root)?;
                *bound_generation = Some(generation);
                *resource_session = Some(session);
                Ok(session)
            }
            _ => Err(INVALID.to_string()),
        }
    }
}

fn allowed_relative_references(bytes: &[u8]) -> HashSet<String> {
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(bytes) else {
        return HashSet::new();
    };
    value
        .pointer("/scene/project/layers")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|layer| {
            let reference = layer.get("reference")?;
            if layer.get("kind")?.as_str()? != "external-scene"
                || reference.get("type")?.as_str()? != "relative"
            {
                return None;
            }
            reference.get("path")?.as_str().map(str::to_owned)
        })
        .collect()
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScenePresetImportResult {
    pub import_capability: String,
    pub bytes: Vec<u8>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScenePresetSaveResult {
    pub save_capability: String,
}

fn is_preset_path(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.ends_with(SUFFIX))
}

fn capability(prefix: &str) -> Result<String, &'static str> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| INTERNAL)?;
    let mut value = String::with_capacity(prefix.len() + 32);
    value.push_str(prefix);
    for byte in bytes {
        use std::fmt::Write as _;
        let _ = write!(value, "{byte:02x}");
    }
    Ok(value)
}

fn bounded_read(path: &Path) -> Result<Vec<u8>, &'static str> {
    if !is_preset_path(path) {
        return Err(INVALID);
    }
    let mut file = open_regular_file(path)?;
    let metadata = file.metadata().map_err(|_| INTERNAL)?;
    #[cfg(target_os = "windows")]
    let initial_identity = file_identity(&file)?;
    if !metadata.is_file() {
        return Err(INVALID);
    }
    if metadata.len() > MAX_BYTES as u64 {
        return Err(TOO_LARGE);
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    (&mut file)
        .take((MAX_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| INTERNAL)?;
    if bytes.len() > MAX_BYTES {
        return Err(TOO_LARGE);
    }
    #[cfg(target_os = "windows")]
    {
        let final_metadata = file.metadata().map_err(|_| INTERNAL)?;
        if final_metadata.len() != metadata.len() || file_identity(&file)? != initial_identity {
            return Err(INTERNAL);
        }
        let current = open_regular_file(path)?;
        if file_identity(&current)? != initial_identity {
            return Err(INTERNAL);
        }
    }
    Ok(bytes)
}

#[cfg(target_os = "windows")]
#[derive(Clone, Copy, PartialEq, Eq)]
struct FileIdentity {
    volume_serial: u32,
    file_index: u64,
}

#[cfg(target_os = "windows")]
fn file_identity(file: &File) -> Result<FileIdentity, &'static str> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };
    let mut information = unsafe { std::mem::zeroed::<BY_HANDLE_FILE_INFORMATION>() };
    if unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &mut information) } == 0 {
        return Err(INTERNAL);
    }
    Ok(FileIdentity {
        volume_serial: information.dwVolumeSerialNumber,
        file_index: (u64::from(information.nFileIndexHigh) << 32)
            | u64::from(information.nFileIndexLow),
    })
}

fn open_regular_file(path: &Path) -> Result<File, &'static str> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)
            .map_err(|_| INTERNAL)?;
        let metadata = file.metadata().map_err(|_| INTERNAL)?;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(INVALID);
        }
        // The handle is retained for the complete bounded read. On Windows the
        // final identity/reparse comparison is performed before this function
        // returns, so pathname replacement cannot turn this into a TOCTOU read.
        return Ok(file);
    }
    #[cfg(not(target_os = "windows"))]
    {
        OpenOptions::new()
            .read(true)
            .open(path)
            .map_err(|_| INTERNAL)
    }
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), &'static str> {
    if bytes.len() > MAX_BYTES {
        return Err(TOO_LARGE);
    }
    let parent = path.parent().ok_or(WRITE_FAILED)?;
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or(WRITE_FAILED)?;
    let temp = parent.join(format!(".{name}.geoim3d-preset-{:x}.tmp", random_u64()?));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|_| WRITE_FAILED)?;
        file.write_all(bytes).map_err(|_| WRITE_FAILED)?;
        file.sync_all().map_err(|_| WRITE_FAILED)?;
        drop(file);
        atomic_replace(&temp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

fn random_u64() -> Result<u64, &'static str> {
    let mut bytes = [0_u8; 8];
    getrandom::fill(&mut bytes).map_err(|_| INTERNAL)?;
    Ok(u64::from_le_bytes(bytes))
}

fn take_save_path(
    state: &ScenePresetTransportState,
    save_capability: &str,
) -> Result<PathBuf, &'static str> {
    let mut sessions = state.sessions.lock().map_err(|_| INTERNAL)?;
    if !matches!(sessions.get(save_capability), Some(Session::Save(_))) {
        return Err(INVALID);
    }
    match sessions.remove(save_capability) {
        Some(Session::Save(path)) => Ok(path),
        _ => Err(INTERNAL),
    }
}

#[cfg(not(target_os = "windows"))]
fn atomic_replace(temp: &Path, target: &Path) -> Result<(), &'static str> {
    fs::rename(temp, target).map_err(|_| WRITE_FAILED)
}

#[cfg(target_os = "windows")]
fn atomic_replace(temp: &Path, target: &Path) -> Result<(), &'static str> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::ReplaceFileW;
    let temp: Vec<u16> = temp.as_os_str().encode_wide().chain(Some(0)).collect();
    let target: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    let ok = unsafe {
        ReplaceFileW(
            target.as_ptr(),
            temp.as_ptr(),
            std::ptr::null(),
            0,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if ok == 0 {
        // A new target has no file to replace; MoveFileEx is still atomic on the
        // same volume and preserves the no-cross-directory-temp invariant.
        use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_WRITE_THROUGH};
        let ok = unsafe { MoveFileExW(temp.as_ptr(), target.as_ptr(), MOVEFILE_WRITE_THROUGH) };
        if ok == 0 {
            return Err(WRITE_FAILED);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn pick_and_read_scene_preset(
    app: tauri::AppHandle,
    state: tauri::State<'_, ScenePresetTransportState>,
) -> Result<ScenePresetImportResult, String> {
    use tauri_plugin_dialog::DialogExt;
    let path = app
        .dialog()
        .file()
        .add_filter("geoIM3D Preset", &[FILTER_EXTENSION])
        .blocking_pick_file()
        .ok_or(CANCELLED)?;
    let path = path.into_path().map_err(|_| INTERNAL)?;
    let bytes = bounded_read(&path).map_err(str::to_string)?;
    let allowed_relative_references = allowed_relative_references(&bytes);
    let root = crate::resource_session::RetainedRoot::capture(path.parent().ok_or(INTERNAL)?)
        .map_err(|error| error.code().to_string())?;
    let token = capability("import-").map_err(str::to_string)?;
    state
        .sessions
        .lock()
        .map_err(|_| INTERNAL.to_string())?
        .insert(
            token.clone(),
            Session::Import {
                root: Some(root),
                allowed_relative_references,
                generation: None,
                resource_session: None,
            },
        );
    Ok(ScenePresetImportResult {
        import_capability: token,
        bytes,
    })
}

#[tauri::command]
pub fn pick_scene_preset_save_target(
    app: tauri::AppHandle,
    state: tauri::State<'_, ScenePresetTransportState>,
) -> Result<ScenePresetSaveResult, String> {
    use tauri_plugin_dialog::DialogExt;
    let path = app
        .dialog()
        .file()
        .add_filter("geoIM3D Preset", &[FILTER_EXTENSION])
        .blocking_save_file()
        .ok_or(CANCELLED)?
        .into_path()
        .map_err(|_| INTERNAL)?;
    if !is_preset_path(&path) {
        return Err(INVALID.to_string());
    }
    let token = capability("save-").map_err(str::to_string)?;
    state
        .sessions
        .lock()
        .map_err(|_| INTERNAL.to_string())?
        .insert(token.clone(), Session::Save(path));
    Ok(ScenePresetSaveResult {
        save_capability: token,
    })
}

#[tauri::command]
pub fn write_scene_preset(
    state: tauri::State<'_, ScenePresetTransportState>,
    save_capability: String,
    bytes: Vec<u8>,
) -> Result<(), String> {
    let path = take_save_path(&state, &save_capability).map_err(str::to_string)?;
    if bytes.len() > MAX_BYTES {
        return Err(TOO_LARGE.to_string());
    }
    atomic_write(&path, &bytes).map_err(str::to_string)
}

#[tauri::command]
pub fn close_scene_preset_session(
    state: tauri::State<'_, ScenePresetTransportState>,
    resource_registry: tauri::State<'_, Arc<crate::resource_session::ResourceSessionRegistry>>,
    import_capability: String,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|_| INTERNAL.to_string())?;
    if !import_capability.starts_with("import-") {
        return Err(INVALID.to_string());
    }
    if matches!(
        sessions.get(&import_capability),
        Some(Session::Import { .. })
    ) {
        resource_registry.close_owner(&import_capability);
        sessions.remove(&import_capability);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn suffix_is_case_sensitive_and_compound() {
        assert!(is_preset_path(Path::new("x.geoim3d-preset.json")));
        assert!(!is_preset_path(Path::new("x.GEOIM3D-PRESET.JSON")));
        assert!(!is_preset_path(Path::new("x.geoim3d-preset.json.bak")));
    }
    #[test]
    fn exact_and_plus_one_are_bounded() {
        let dir = tempfile_dir();
        let path = dir.join("x.geoim3d-preset.json");
        fs::write(&path, vec![1; MAX_BYTES]).unwrap();
        assert_eq!(bounded_read(&path).unwrap().len(), MAX_BYTES);
        fs::write(&path, vec![1; MAX_BYTES + 1]).unwrap();
        assert_eq!(bounded_read(&path), Err(TOO_LARGE));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn native_allowlist_extracts_only_declared_relative_scene_references() {
        let bytes = br#"{"scene":{"project":{"layers":[{"kind":"external-scene","reference":{"type":"relative","path":"models/a.glb"}},{"kind":"external-scene","reference":{"type":"https","url":"https://example.com/b.glb"}},{"kind":"geojson","reference":{"type":"relative","path":"ignored.glb"}}]}}}"#;
        assert_eq!(
            allowed_relative_references(bytes),
            HashSet::from(["models/a.glb".to_string()])
        );
        assert!(allowed_relative_references(b"not-json").is_empty());
    }

    #[test]
    fn capability_lifecycle_is_single_use_route_bound_and_close_idempotent() {
        let state = ScenePresetTransportState::default();
        let import = capability("import-").unwrap();
        let save = capability("save-").unwrap();
        state.sessions.lock().unwrap().insert(
            import.clone(),
            Session::Import {
                root: None,
                allowed_relative_references: HashSet::new(),
                generation: None,
                resource_session: None,
            },
        );
        state
            .sessions
            .lock()
            .unwrap()
            .insert(save.clone(), Session::Save(PathBuf::from("save")));
        assert_eq!(take_save_path(&state, &import), Err(INVALID));
        let mut sessions = state.sessions.lock().unwrap();
        assert!(matches!(
            sessions.remove(&import),
            Some(Session::Import { root: None, .. })
        ));
        assert!(sessions.remove(&import).is_none());
        drop(sessions);
        assert_eq!(take_save_path(&state, &save), Ok(PathBuf::from("save")));
        assert_eq!(take_save_path(&state, &save), Err(INVALID));
    }

    #[test]
    fn import_capability_binds_one_native_session_to_one_generation() {
        let state = ScenePresetTransportState::default();
        let registry = crate::resource_session::ResourceSessionRegistry::default();
        let root = tempfile_dir();
        let import = capability("import-").unwrap();
        state.sessions.lock().unwrap().insert(
            import.clone(),
            Session::Import {
                root: Some(crate::resource_session::RetainedRoot::capture(&root).unwrap()),
                allowed_relative_references: HashSet::from(["models/model.glb".to_string()]),
                generation: None,
                resource_session: None,
            },
        );
        let create = |root| {
            registry
                .create_bound_owner_retained(root, 7, "scene-preset", Some(import.clone()))
                .map_err(|_| INTERNAL.to_string())
        };
        let first = state
            .import_resource_session(&import, 7, "models/model.glb", create)
            .unwrap();
        let second = state
            .import_resource_session(&import, 7, "models/model.glb", |_| {
                panic!("session must be reused")
            })
            .unwrap();
        assert_eq!(first, second);
        assert_eq!(registry.session_count(), 1);
        assert_eq!(
            state.import_resource_session(&import, 8, "models/model.glb", |_| {
                panic!("generation must fail")
            }),
            Err(INVALID.to_string())
        );
        assert_eq!(
            state.import_resource_session(&import, 7, "other.glb", |_| {
                panic!("unlisted reference must fail")
            }),
            Err(INVALID.to_string())
        );
        registry.close_owner(&import);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn atomic_write_replaces_target_and_leaves_no_temp_on_success() {
        let dir = tempfile_dir();
        let target = dir.join("x.geoim3d-preset.json");
        fs::write(&target, b"old").unwrap();
        atomic_write(&target, b"new").unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"new");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        let _ = fs::remove_dir_all(dir);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn bounded_read_rejects_reparse_point_files() {
        use std::os::windows::fs::symlink_file;

        let dir = tempfile_dir();
        let target = dir.join("target.json");
        let link = dir.join("link.geoim3d-preset.json");
        fs::write(&target, b"{}").unwrap();
        symlink_file(&target, &link).unwrap();
        assert_eq!(bounded_read(&link), Err(INVALID));
        let _ = fs::remove_dir_all(dir);
    }

    fn tempfile_dir() -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("geoim3d-preset-test-{}", random_u64().unwrap()));
        fs::create_dir(&dir).unwrap();
        dir
    }
}
