use std::fs::{self, File};
use std::io::Read;

pub(crate) const MAX_PROJECT_FILE_BYTES: u64 = 8 * 1024 * 1024;
const PROJECT_FILE_INVALID: &str = "PROJECT_FILE_INVALID";
const PROJECT_FILE_TOO_LARGE: &str = "PROJECT_FILE_TOO_LARGE";
const PROJECT_FILE_CHANGED: &str = "PROJECT_FILE_CHANGED";
const PROJECT_FILE_UNREADABLE: &str = "PROJECT_FILE_UNREADABLE";
const PROJECT_FILE_NOT_FOUND: &str = "PROJECT_FILE_NOT_FOUND";

fn stable_read_error(error: &std::io::Error) -> String {
    if error.kind() == std::io::ErrorKind::NotFound {
        PROJECT_FILE_NOT_FOUND.to_string()
    } else {
        PROJECT_FILE_UNREADABLE.to_string()
    }
}

/// Restrict project reads to absolute, non-UNC canonical geoIM3D project paths.
pub(crate) fn is_allowed_project_path(path: &str) -> bool {
    let bytes = path.as_bytes();
    let is_separator = |byte: u8| byte == b'/' || byte == b'\\';
    if bytes.len() >= 2 && is_separator(bytes[0]) && is_separator(bytes[1]) {
        return false;
    }
    let is_posix_absolute = bytes.first() == Some(&b'/');
    let is_windows_drive = bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && is_separator(bytes[2]);
    if !is_posix_absolute && !is_windows_drive {
        return false;
    }
    if path.split(['/', '\\']).any(|segment| segment == "..") {
        return false;
    }
    path.to_ascii_lowercase().ends_with(".geoim3d.json")
}

/// Same-handle, max+1 bounded binary reader for canonical local projects.
pub(crate) fn read_project_file_bytes(path: &str) -> Result<Vec<u8>, String> {
    if !is_allowed_project_path(path) {
        return Err(PROJECT_FILE_INVALID.to_string());
    }
    let canonical = fs::canonicalize(path).map_err(|error| stable_read_error(&error))?;
    let resolved = canonical.to_string_lossy().to_ascii_lowercase();
    if !resolved.ends_with(".geoim3d.json") {
        return Err(PROJECT_FILE_INVALID.to_string());
    }

    let mut file = File::open(&canonical).map_err(|error| stable_read_error(&error))?;
    let initial = file.metadata().map_err(|error| stable_read_error(&error))?;
    if !initial.is_file() {
        return Err(PROJECT_FILE_INVALID.to_string());
    }
    if initial.len() > MAX_PROJECT_FILE_BYTES {
        return Err(PROJECT_FILE_TOO_LARGE.to_string());
    }

    let capacity = usize::try_from(initial.len())
        .unwrap_or(0)
        .min(MAX_PROJECT_FILE_BYTES as usize);
    let mut bytes = Vec::with_capacity(capacity);
    (&mut file)
        .take(MAX_PROJECT_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| stable_read_error(&error))?;
    let final_metadata = file
        .metadata()
        .map_err(|_| PROJECT_FILE_CHANGED.to_string())?;
    if bytes.len() as u64 > MAX_PROJECT_FILE_BYTES {
        return Err(PROJECT_FILE_TOO_LARGE.to_string());
    }
    if final_metadata.len() != initial.len() || bytes.len() as u64 != initial.len() {
        return Err(PROJECT_FILE_CHANGED.to_string());
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::{
        is_allowed_project_path, read_project_file_bytes, MAX_PROJECT_FILE_BYTES,
        PROJECT_FILE_INVALID,
    };
    use std::path::PathBuf;

    struct ScratchDir(PathBuf);

    impl ScratchDir {
        fn new() -> Self {
            let path = std::env::temp_dir()
                .join(format!("geoim3d-project-file-test-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&path);
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for ScratchDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn accepts_only_canonical_absolute_project_paths() {
        assert!(is_allowed_project_path("/tmp/map.geoim3d.json"));
        assert!(is_allowed_project_path("C:\\Users\\u\\map.geoim3d.json"));
        assert!(!is_allowed_project_path("relative.geoim3d.json"));
        assert!(!is_allowed_project_path("/tmp/../secret.geoim3d.json"));
        assert!(!is_allowed_project_path("/tmp/map.json"));
        assert!(!is_allowed_project_path(
            "\\\\server\\share\\map.geoim3d.json"
        ));
        assert_eq!(
            read_project_file_bytes("relative.geoim3d.json").unwrap_err(),
            PROJECT_FILE_INVALID
        );
    }

    #[test]
    fn allows_exact_eight_mibibytes_and_rejects_plus_one() {
        let root = ScratchDir::new();
        let exact = root.0.join("exact.geoim3d.json");
        std::fs::File::create(&exact)
            .unwrap()
            .set_len(MAX_PROJECT_FILE_BYTES)
            .unwrap();
        assert_eq!(
            read_project_file_bytes(exact.to_str().unwrap())
                .unwrap()
                .len() as u64,
            MAX_PROJECT_FILE_BYTES
        );

        let over = root.0.join("over.geoim3d.json");
        std::fs::File::create(&over)
            .unwrap()
            .set_len(MAX_PROJECT_FILE_BYTES + 1)
            .unwrap();
        assert!(read_project_file_bytes(over.to_str().unwrap()).is_err());
    }
}
