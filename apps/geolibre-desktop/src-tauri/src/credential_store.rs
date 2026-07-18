use std::collections::HashMap;

use serde::Serialize;

const CREDENTIAL_SERVICE: &str = "com.ejbt.geoim3d";
pub(crate) const ALLOWED_CREDENTIAL_IDS: [&str; 27] = [
    "share:token",
    "cesium:ion-token",
    "vworld:api-key",
    "geocoder:nominatim:api-key",
    "geocoder:pelias:api-key",
    "geocoder:arcgis:api-key",
    "geocoder:mapbox:api-key",
    "geocoder:google:api-key",
    "ai:GEMINI_API_KEY",
    "ai:ANTHROPIC_API_KEY",
    "ai:OPENAI_API_KEY",
    "ai:TAVILY_API_KEY",
    "ai:OLLAMA_BASE_URL",
    "ai:OLLAMA_MODEL",
    "ai:AWS_ACCESS_KEY_ID",
    "ai:AWS_SECRET_ACCESS_KEY",
    "ai:AWS_REGION",
    "ai:AWS_SESSION_TOKEN",
    "ai:OPENAI_COMPATIBLE_BASE_URL",
    "ai:OPENAI_COMPATIBLE_MODEL",
    "ai:OPENAI_COMPATIBLE_API_KEY",
    "map:google-maps-api-key",
    "map:mapillary-access-token",
    "map:protomaps-api-key",
    "map:tomtom-api-key",
    "map:here-api-key",
    "map:amazon-location-api-key",
];
const WRITE_ONLY_CREDENTIAL_IDS: [&str; 1] = ["vworld:api-key"];

const BACKEND_UNAVAILABLE: &str = "credential_backend_unavailable";
const INVALID_ID: &str = "credential_invalid_id";
const READ_FAILED: &str = "credential_read_failed";
const WRITE_FAILED: &str = "credential_write_failed";
const DELETE_FAILED: &str = "credential_delete_failed";
const INVALID_VALUE: &str = "credential_invalid_value";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialLoadResult {
    values: HashMap<String, String>,
    configured_ids: Vec<String>,
    error_code: Option<&'static str>,
}

fn is_write_only(credential_id: &str) -> bool {
    WRITE_ONLY_CREDENTIAL_IDS.contains(&credential_id)
}

fn validate_id(credential_id: &str) -> Result<&str, String> {
    if ALLOWED_CREDENTIAL_IDS.contains(&credential_id) {
        Ok(credential_id)
    } else {
        Err(INVALID_ID.to_string())
    }
}

#[cfg(target_os = "windows")]
fn entry(credential_id: &str) -> Result<keyring::Entry, String> {
    let id = validate_id(credential_id)?;
    keyring::Entry::new(CREDENTIAL_SERVICE, id).map_err(|_| BACKEND_UNAVAILABLE.to_string())
}

#[cfg(target_os = "windows")]
fn is_not_found(error: &keyring::Error) -> bool {
    matches!(error, keyring::Error::NoEntry)
}

pub(crate) fn read_credential(credential_id: &str) -> Result<Option<String>, String> {
    validate_id(credential_id)?;
    #[cfg(target_os = "windows")]
    {
        match entry(credential_id)?.get_password() {
            Ok(value) if !value.trim().is_empty() => Ok(Some(value.trim().to_string())),
            Ok(_) => Ok(None),
            Err(error) if is_not_found(&error) => Ok(None),
            Err(_) => Err(READ_FAILED.to_string()),
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err(BACKEND_UNAVAILABLE.to_string())
    }
}

#[tauri::command]
pub fn credential_load() -> Result<CredentialLoadResult, String> {
    #[cfg(target_os = "windows")]
    {
        let mut values = HashMap::new();
        let mut configured_ids = Vec::new();
        let mut failed = false;
        for credential_id in ALLOWED_CREDENTIAL_IDS {
            let Ok(entry) = entry(credential_id) else {
                failed = true;
                continue;
            };
            match entry.get_password() {
                Ok(value) if !value.trim().is_empty() => {
                    configured_ids.push(credential_id.to_string());
                    if !is_write_only(credential_id) {
                        values.insert(credential_id.to_string(), value);
                    }
                }
                Ok(_) => {}
                Err(error) if is_not_found(&error) => {}
                Err(_) => failed = true,
            }
        }
        Ok(CredentialLoadResult {
            values,
            configured_ids,
            error_code: failed.then_some(READ_FAILED),
        })
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err(BACKEND_UNAVAILABLE.to_string())
    }
}

#[tauri::command]
pub fn credential_set(credential_id: String, value: String) -> Result<(), String> {
    validate_id(&credential_id)?;
    if value.trim().is_empty() {
        return Err(INVALID_VALUE.to_string());
    }

    #[cfg(target_os = "windows")]
    {
        entry(&credential_id)?
            .set_password(value.trim())
            .map_err(|_| WRITE_FAILED.to_string())
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = value;
        Err(BACKEND_UNAVAILABLE.to_string())
    }
}

#[tauri::command]
pub fn credential_delete(credential_id: String) -> Result<(), String> {
    validate_id(&credential_id)?;

    #[cfg(target_os = "windows")]
    {
        match entry(&credential_id)?.delete_credential() {
            Ok(()) => Ok(()),
            Err(error) if is_not_found(&error) => Ok(()),
            Err(_) => Err(DELETE_FAILED.to_string()),
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err(BACKEND_UNAVAILABLE.to_string())
    }
}

#[tauri::command]
pub fn credential_clear() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let mut failed = false;
        for credential_id in ALLOWED_CREDENTIAL_IDS {
            let Ok(entry) = entry(credential_id) else {
                failed = true;
                continue;
            };
            match entry.delete_credential() {
                Ok(()) => {}
                Err(error) if is_not_found(&error) => {}
                Err(_) => failed = true,
            }
        }
        if failed {
            Err(DELETE_FAILED.to_string())
        } else {
            Ok(())
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err(BACKEND_UNAVAILABLE.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credential_id_allowlist_accepts_only_product_ids() {
        assert!(validate_id("share:token").is_ok());
        assert!(validate_id("ai:OPENAI_API_KEY").is_ok());
        assert!(validate_id("../../arbitrary").is_err());
        assert!(validate_id("AWS_PROFILE").is_err());
        assert!(is_write_only("vworld:api-key"));
        assert!(!is_write_only("cesium:ion-token"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_credential_manager_round_trip() {
        use std::time::{SystemTime, UNIX_EPOCH};

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock must be after Unix epoch")
            .as_nanos();
        let account = format!("test:{}:{nonce}", std::process::id());
        let entry = keyring::Entry::new("com.ejbt.geoim3d.test", &account)
            .expect("test credential entry must initialize");
        let value = "geoim3d-credential-round-trip";

        let write_result = entry.set_password(value);
        let read_result = entry.get_password();
        let delete_result = entry.delete_credential();

        assert!(write_result.is_ok(), "Windows credential write failed");
        assert!(
            matches!(read_result.as_deref(), Ok(actual) if actual == value),
            "Windows credential read failed"
        );
        assert!(delete_result.is_ok(), "Windows credential cleanup failed");
    }
}
