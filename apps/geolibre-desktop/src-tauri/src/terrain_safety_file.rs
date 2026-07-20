use std::path::Path;

#[cfg(target_os = "windows")]
use tauri_plugin_dialog::DialogExt;

const TERRAIN_SAFETY_MAX_BYTES: u64 = 48 * 1024 * 1024;
const FILE_INVALID: &str = "TERRAIN_SAFETY_FILE_INVALID";
const FILE_TOO_LARGE: &str = "TERRAIN_SAFETY_FILE_TOO_LARGE";
const FILE_READ_FAILED: &str = "TERRAIN_SAFETY_FILE_READ_FAILED";
const TIFF_INVALID: &str = "TERRAIN_SAFETY_TIFF_INVALID";

fn has_allowed_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| {
            value.eq_ignore_ascii_case("tif") || value.eq_ignore_ascii_case("tiff")
        })
}

fn has_tiff_magic(bytes: &[u8]) -> bool {
    matches!(bytes, [b'I', b'I', 42, 0, ..] | [b'M', b'M', 0, 42, ..])
}

#[cfg(target_os = "windows")]
#[derive(Clone, Copy, PartialEq, Eq)]
struct FileIdentity {
    volume_serial: u32,
    file_index: u64,
}

#[cfg(target_os = "windows")]
fn file_identity(file: &std::fs::File) -> Result<FileIdentity, String> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };

    let mut information = unsafe { std::mem::zeroed::<BY_HANDLE_FILE_INFORMATION>() };
    let succeeded =
        unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &mut information) };
    if succeeded == 0 {
        return Err(FILE_READ_FAILED.to_string());
    }
    Ok(FileIdentity {
        volume_serial: information.dwVolumeSerialNumber,
        file_index: (u64::from(information.nFileIndexHigh) << 32)
            | u64::from(information.nFileIndexLow),
    })
}

#[cfg(target_os = "windows")]
fn read_bounded(path: &Path) -> Result<Vec<u8>, String> {
    read_bounded_after_metadata(path, || {})
}

#[cfg(target_os = "windows")]
fn read_bounded_after_metadata<F>(path: &Path, after_metadata: F) -> Result<Vec<u8>, String>
where
    F: FnOnce(),
{
    use std::fs::OpenOptions;
    use std::io::{Read, Seek, SeekFrom};
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};

    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
    const READ_CHUNK_BYTES: usize = 64 * 1024;

    if !has_allowed_extension(path) {
        return Err(FILE_INVALID.to_string());
    }

    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(|_| FILE_READ_FAILED.to_string())?;
    let initial = file.metadata().map_err(|_| FILE_READ_FAILED.to_string())?;
    let initial_identity = file_identity(&file)?;
    if !initial.is_file() || initial.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(FILE_INVALID.to_string());
    }
    if initial.len() > TERRAIN_SAFETY_MAX_BYTES {
        return Err(FILE_TOO_LARGE.to_string());
    }
    after_metadata();

    let mut magic = [0_u8; 4];
    file.read_exact(&mut magic)
        .map_err(|_| TIFF_INVALID.to_string())?;
    if !has_tiff_magic(&magic) {
        return Err(TIFF_INVALID.to_string());
    }
    file.seek(SeekFrom::Start(0))
        .map_err(|_| FILE_READ_FAILED.to_string())?;

    let maximum = TERRAIN_SAFETY_MAX_BYTES as usize;
    let initial_capacity = usize::try_from(initial.len())
        .unwrap_or(maximum)
        .min(maximum);
    let mut bytes = Vec::with_capacity(initial_capacity);
    let mut chunk = [0_u8; READ_CHUNK_BYTES];
    loop {
        let remaining = maximum.saturating_sub(bytes.len());
        if remaining == 0 {
            let mut probe = [0_u8; 1];
            if file
                .read(&mut probe)
                .map_err(|_| FILE_READ_FAILED.to_string())?
                != 0
            {
                return Err(FILE_TOO_LARGE.to_string());
            }
            break;
        }
        let read_limit = remaining.min(chunk.len());
        let count = file
            .read(&mut chunk[..read_limit])
            .map_err(|_| FILE_READ_FAILED.to_string())?;
        if count == 0 {
            break;
        }
        bytes.extend_from_slice(&chunk[..count]);
    }

    let final_metadata = file.metadata().map_err(|_| FILE_READ_FAILED.to_string())?;
    let final_identity = file_identity(&file)?;
    if final_metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || final_identity != initial_identity
        || final_metadata.len() != initial.len()
        || final_metadata.len() != bytes.len() as u64
    {
        return Err(FILE_READ_FAILED.to_string());
    }

    // The read itself remains single-handle. Reopen only for a final pathname
    // identity check so replacing the directory entry while the original handle
    // stays valid cannot make the UI believe bytes came from the currently named file.
    let current_path_file = OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(|_| FILE_READ_FAILED.to_string())?;
    let current_path_metadata = current_path_file
        .metadata()
        .map_err(|_| FILE_READ_FAILED.to_string())?;
    if current_path_metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || file_identity(&current_path_file)? != initial_identity
    {
        return Err(FILE_READ_FAILED.to_string());
    }
    if !has_tiff_magic(&bytes) {
        return Err(TIFF_INVALID.to_string());
    }
    Ok(bytes)
}

#[cfg(not(target_os = "windows"))]
fn read_bounded(_path: &Path) -> Result<Vec<u8>, String> {
    Err(FILE_READ_FAILED.to_string())
}

#[cfg(target_os = "windows")]
#[tauri::command]
pub async fn pick_and_read_terrain_safety_geotiff(
    app: tauri::AppHandle,
) -> Result<tauri::ipc::Response, String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter("GeoTIFF DEM", &["tif", "tiff"])
        .pick_file(move |selection| {
            let _ = sender.send(selection);
        });
    let selected = receiver
        .await
        .map_err(|_| FILE_READ_FAILED.to_string())?
        .ok_or_else(|| "TERRAIN_SAFETY_PICK_CANCELLED".to_string())?;
    let path = selected.into_path().map_err(|_| FILE_INVALID.to_string())?;
    read_bounded(&path).map(tauri::ipc::Response::new)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_tiff_extensions() {
        assert!(has_allowed_extension(Path::new("C:/data/model.tif")));
        assert!(has_allowed_extension(Path::new("C:/data/model.TIFF")));
        assert!(!has_allowed_extension(Path::new("C:/data/model.tif.exe")));
        assert!(!has_allowed_extension(Path::new("C:/data/model")));
    }

    #[test]
    fn accepts_only_classic_tiff_magic() {
        assert!(has_tiff_magic(&[b'I', b'I', 42, 0]));
        assert!(has_tiff_magic(&[b'M', b'M', 0, 42, 1]));
        assert!(!has_tiff_magic(&[b'I', b'I', 43, 0]));
        assert!(!has_tiff_magic(&[0, 0, 0, 0]));
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn non_windows_runtime_fails_closed() {
        assert_eq!(
            read_bounded(Path::new("/tmp/model.tif")).unwrap_err(),
            FILE_READ_FAILED
        );
    }

    #[cfg(target_os = "windows")]
    fn temporary_path(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "geoim3d-terrain-safety-{}-{name}.tif",
            std::process::id()
        ))
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn reads_regular_tiff_from_one_bounded_handle() {
        let path = temporary_path("regular");
        let expected = [b'I', b'I', 42, 0, 8, 0, 0, 0];
        std::fs::write(&path, expected).unwrap();
        assert_eq!(read_bounded(&path).unwrap(), expected);
        let _ = std::fs::remove_file(path);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn rejects_initially_oversized_file_before_reading_payload() {
        let path = temporary_path("oversized");
        let file = std::fs::File::create(&path).unwrap();
        file.set_len(TERRAIN_SAFETY_MAX_BYTES + 1).unwrap();
        drop(file);
        assert_eq!(read_bounded(&path).unwrap_err(), FILE_TOO_LARGE);
        let _ = std::fs::remove_file(path);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn rejects_file_symlink_reparse_points_when_supported() {
        use std::os::windows::fs::symlink_file;

        let target = temporary_path("target");
        let link = temporary_path("link");
        std::fs::write(&target, [b'I', b'I', 42, 0, 8, 0, 0, 0]).unwrap();
        if symlink_file(&target, &link).is_ok() {
            assert_eq!(read_bounded(&link).unwrap_err(), FILE_INVALID);
            let _ = std::fs::remove_file(&link);
        }
        let _ = std::fs::remove_file(target);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn accepts_exact_maximum_size() {
        use std::io::{Seek, SeekFrom, Write};

        let path = temporary_path("exact-maximum");
        let mut file = std::fs::File::create(&path).unwrap();
        file.set_len(TERRAIN_SAFETY_MAX_BYTES).unwrap();
        file.seek(SeekFrom::Start(0)).unwrap();
        file.write_all(&[b'I', b'I', 42, 0]).unwrap();
        drop(file);
        assert_eq!(
            read_bounded(&path).unwrap().len() as u64,
            TERRAIN_SAFETY_MAX_BYTES
        );
        let _ = std::fs::remove_file(path);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn rejects_path_replacement_after_initial_metadata() {
        let path = temporary_path("replace-live");
        let displaced = temporary_path("replace-displaced");
        let replacement = temporary_path("replace-new");
        std::fs::write(&path, [b'I', b'I', 42, 0, 8, 0, 0, 0]).unwrap();
        std::fs::write(&replacement, [b'I', b'I', 42, 0, 9, 0, 0, 0]).unwrap();
        let result = read_bounded_after_metadata(&path, || {
            std::fs::rename(&path, &displaced).unwrap();
            std::fs::rename(&replacement, &path).unwrap();
        });
        assert_eq!(result.unwrap_err(), FILE_READ_FAILED);
        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_file(displaced);
        let _ = std::fs::remove_file(replacement);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn rejects_growth_after_initial_handle_metadata() {
        use std::io::Write;

        let path = temporary_path("growth");
        std::fs::write(&path, [b'I', b'I', 42, 0, 8, 0, 0, 0]).unwrap();
        let result = read_bounded_after_metadata(&path, || {
            let mut file = std::fs::OpenOptions::new()
                .append(true)
                .open(&path)
                .unwrap();
            file.write_all(&[1]).unwrap();
        });
        assert_eq!(result.unwrap_err(), FILE_READ_FAILED);
        let _ = std::fs::remove_file(path);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn rejects_truncation_after_initial_handle_metadata() {
        let path = temporary_path("truncate");
        std::fs::write(&path, [b'I', b'I', 42, 0, 8, 0, 0, 0]).unwrap();
        let result = read_bounded_after_metadata(&path, || {
            std::fs::OpenOptions::new()
                .write(true)
                .open(&path)
                .unwrap()
                .set_len(4)
                .unwrap();
        });
        assert_eq!(result.unwrap_err(), FILE_READ_FAILED);
        let _ = std::fs::remove_file(path);
    }
}
