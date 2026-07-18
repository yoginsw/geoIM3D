use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::oneshot;

const API_BASE: &str = "https://api.vworld.kr";
const SEARCH_PATH: &str = "/req/search";
const ADDRESS_PATH: &str = "/req/address";
const DATA_PATH: &str = "/req/data";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_JSON_BYTES: usize = 1_048_576;
const MAX_PNG_BYTES: usize = 8 * 1024 * 1024;
const MAX_QUERY_CHARS: usize = 200;
const MAX_ADDRESS_CHARS: usize = 300;
const CANCEL_ID_CHARS: usize = 96;
const DAILY_GEOCODER_LIMIT: u32 = 40_000;

const ERR_INVALID_REQUEST: &str = "vworld_invalid_request";
const ERR_INVALID_REQUEST_ID: &str = "vworld_invalid_request_id";
const ERR_DUPLICATE_REQUEST_ID: &str = "vworld_duplicate_request_id";
const ERR_CANCELLED: &str = "vworld_cancelled";
const ERR_MISSING_KEY: &str = "vworld_missing_api_key";
const ERR_CREDENTIAL: &str = "vworld_credential_unavailable";
const ERR_NETWORK: &str = "vworld_network_error";
const ERR_TIMEOUT: &str = "vworld_timeout";
const ERR_HTTP: &str = "vworld_http_error";
const ERR_RESPONSE: &str = "vworld_invalid_response";
const ERR_PNG: &str = "vworld_invalid_tile";
const ERR_RATE_LIMIT: &str = "vworld_rate_limit";

#[derive(Default)]
struct DailyUsage {
    utc_day: u64,
    count: u32,
}

#[derive(Default)]
pub struct VWorldState {
    requests: Arc<Mutex<HashMap<String, oneshot::Sender<()>>>>,
    geocoder_usage: Arc<Mutex<DailyUsage>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchRequest {
    pub query: String,
    #[serde(rename = "type")]
    pub search_type: String,
    pub category: Option<String>,
    pub size: Option<u16>,
    pub page: Option<u32>,
    pub bbox: Option<[f64; 4]>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeocodeRequest {
    pub address: String,
    #[serde(rename = "type")]
    pub address_type: String,
    pub refine: Option<bool>,
    pub simple: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReverseGeocodeRequest {
    pub point: [f64; 2],
    #[serde(rename = "type")]
    pub address_type: Option<String>,
    pub zipcode: Option<bool>,
    pub simple: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeatureRequest {
    pub service: String,
    pub size: Option<u16>,
    pub page: Option<u32>,
    pub pnu: Option<String>,
    pub geometry: Option<GeometryFilter>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(tag = "type", rename_all = "UPPERCASE")]
pub enum GeometryFilter {
    Point { coordinates: [f64; 2] },
    Box { bounds: [f64; 4] },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TileRequest {
    pub layer: String,
    pub z: u8,
    pub x: u32,
    pub y: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VWorldResponse {
    pub status: String,
    pub record: Option<Value>,
    pub page: Option<Value>,
    pub result: Option<Value>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TileResponse {
    pub content_type: &'static str,
    pub bytes: Vec<u8>,
}

fn invalid<T>() -> Result<T, String> {
    Err(ERR_INVALID_REQUEST.to_string())
}
fn finite(v: f64) -> bool {
    v.is_finite()
}
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= CANCEL_ID_CHARS
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}
fn register(state: &VWorldState, id: &str) -> Result<oneshot::Receiver<()>, String> {
    if !valid_id(id) {
        return Err(ERR_INVALID_REQUEST_ID.into());
    }
    let (tx, rx) = oneshot::channel();
    let mut requests = state.requests.lock().map_err(|_| ERR_NETWORK.to_string())?;
    if requests.contains_key(id) {
        return Err(ERR_DUPLICATE_REQUEST_ID.into());
    }
    requests.insert(id.to_string(), tx);
    Ok(rx)
}
fn unregister(state: &VWorldState, id: &str) {
    if let Ok(mut requests) = state.requests.lock() {
        requests.remove(id);
    }
}

fn cancel_request(state: &VWorldState, request_id: &str) -> Result<(), String> {
    let sender = state
        .requests
        .lock()
        .map_err(|_| ERR_NETWORK.to_string())?
        .remove(request_id)
        .ok_or_else(|| ERR_INVALID_REQUEST_ID.to_string())?;
    let _ = sender.send(());
    Ok(())
}

fn credential_key() -> Result<String, String> {
    match crate::credential_store::read_credential("vworld:api-key") {
        Ok(Some(key)) if !key.trim().is_empty() => {
            let key = key.trim();
            if key.len() > 256
                || !key
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-' | b'~'))
            {
                return Err(ERR_CREDENTIAL.into());
            }
            Ok(key.to_string())
        }
        Ok(_) => Err(ERR_MISSING_KEY.into()),
        Err(_) => Err(ERR_CREDENTIAL.into()),
    }
}

fn with_credential<T, R, B>(read: R, build: B) -> Result<T, String>
where
    R: FnOnce() -> Result<String, String>,
    B: FnOnce(String) -> Result<T, String>,
{
    build(read()?)
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| ERR_NETWORK.into())
}
fn query_value(value: &str) -> String {
    value.trim().to_string()
}
fn page_size(size: Option<u16>) -> Result<u16, String> {
    let n = size.unwrap_or(10);
    (1..=1000)
        .contains(&n)
        .then_some(n)
        .ok_or_else(|| ERR_INVALID_REQUEST.into())
}
fn page_number(page: Option<u32>) -> Result<u32, String> {
    let n = page.unwrap_or(1);
    (n >= 1)
        .then_some(n)
        .ok_or_else(|| ERR_INVALID_REQUEST.into())
}
fn valid_bbox([min_x, min_y, max_x, max_y]: [f64; 4]) -> bool {
    finite(min_x)
        && finite(min_y)
        && finite(max_x)
        && finite(max_y)
        && (-180.0..=180.0).contains(&min_x)
        && (-180.0..=180.0).contains(&max_x)
        && (-90.0..=90.0).contains(&min_y)
        && (-90.0..=90.0).contains(&max_y)
        && min_x <= max_x
        && min_y <= max_y
}
fn valid_address_type(value: &str) -> bool {
    matches!(value, "ROAD" | "PARCEL")
}
fn valid_search_type(value: &str) -> bool {
    matches!(value, "PLACE" | "ADDRESS" | "DISTRICT" | "ROAD")
}
fn valid_search_category(search_type: &str, category: Option<&str>) -> bool {
    match (search_type, category) {
        ("PLACE" | "ROAD", None) => true,
        ("ADDRESS", Some(value)) => matches!(value, "ROAD" | "PARCEL"),
        ("DISTRICT", Some(value)) => matches!(value, "L1" | "L2" | "L3" | "L4"),
        _ => false,
    }
}
fn valid_keyed_layer(layer: &str) -> bool {
    matches!(layer, "Base" | "white" | "midnight" | "Hybrid")
}
fn valid_tile(req: &TileRequest) -> bool {
    let max_zoom = if req.layer == "Base" { 19 } else { 18 };
    if !valid_keyed_layer(&req.layer) || req.z < 6 || req.z > max_zoom {
        return false;
    }
    let dimension = 1_u64 << req.z;
    u64::from(req.x) < dimension && u64::from(req.y) < dimension
}

fn endpoint_url(path: &str) -> String {
    format!("{API_BASE}{path}")
}

fn reserve_geocoder_request(state: &VWorldState) -> Result<(), String> {
    let utc_day = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        / 86_400;
    let mut usage = state
        .geocoder_usage
        .lock()
        .map_err(|_| ERR_RESPONSE.to_string())?;
    if usage.utc_day != utc_day {
        usage.utc_day = utc_day;
        usage.count = 0;
    }
    if usage.count >= DAILY_GEOCODER_LIMIT {
        return Err(ERR_RATE_LIMIT.to_string());
    }
    usage.count += 1;
    Ok(())
}

async fn read_limited(mut response: reqwest::Response, limit: usize) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|error| {
        if error.is_timeout() {
            ERR_TIMEOUT.to_string()
        } else {
            ERR_NETWORK.to_string()
        }
    })? {
        if bytes.len().saturating_add(chunk.len()) > limit {
            return Err(ERR_RESPONSE.into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

async fn json_request<F>(mut cancel: oneshot::Receiver<()>, request: F) -> Result<Value, String>
where
    F: std::future::Future<Output = Result<reqwest::Response, reqwest::Error>>,
{
    let response = tokio::select! { _ = &mut cancel => return Err(ERR_CANCELLED.into()), response = request => response };
    let response = response.map_err(|e| {
        if e.is_timeout() {
            ERR_TIMEOUT
        } else {
            ERR_NETWORK
        }
    })?;
    if !response.status().is_success() {
        return Err(ERR_HTTP.into());
    }
    let bytes = tokio::select! {
        _ = &mut cancel => return Err(ERR_CANCELLED.into()),
        bytes = read_limited(response, MAX_JSON_BYTES) => bytes?,
    };
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| ERR_RESPONSE.to_string())?;
    Ok(value)
}

async fn execute_json(
    state: &VWorldState,
    request_id: &str,
    request: reqwest::RequestBuilder,
) -> Result<Value, String> {
    let cancel = register(state, request_id)?;
    execute_registered_json(state, request_id, cancel, request).await
}

async fn execute_registered_json(
    state: &VWorldState,
    request_id: &str,
    cancel: oneshot::Receiver<()>,
    request: reqwest::RequestBuilder,
) -> Result<Value, String> {
    let result = json_request(cancel, request.send()).await;
    unregister(state, request_id);
    result
}

fn register_geocoder_request(
    state: &VWorldState,
    request_id: &str,
) -> Result<oneshot::Receiver<()>, String> {
    let cancel = register(state, request_id)?;
    if let Err(error) = reserve_geocoder_request(state) {
        unregister(state, request_id);
        return Err(error);
    }
    Ok(cancel)
}
fn response_dto(value: Value) -> VWorldResponse {
    let status = value
        .get("response")
        .and_then(|v| v.get("status"))
        .and_then(Value::as_str)
        .unwrap_or("ERROR");
    let status = match status {
        "OK" => "OK",
        "NOT_FOUND" => "NOT_FOUND",
        _ => "ERROR",
    }
    .to_string();
    let response = value.get("response").unwrap_or(&value);
    let result = response.get("result").map(sanitize_value);
    VWorldResponse {
        status,
        record: response.get("record").map(sanitize_value),
        page: response.get("page").map(sanitize_value),
        result,
    }
}
fn sanitize_value(value: &Value) -> Value {
    const ALLOWED: &[&str] = &[
        "id",
        "title",
        "category",
        "address",
        "point",
        "x",
        "y",
        "zipcode",
        "type",
        "text",
        "structure",
        "level0",
        "level1",
        "level2",
        "level3",
        "level4L",
        "level4LC",
        "level4A",
        "level4AC",
        "level5",
        "detail",
        "geometry",
        "coordinates",
        "properties",
        "features",
        "featureCollection",
        "items",
        "item",
        "road",
        "parcel",
        "refined",
        "pnu",
        "jibun",
        "bonbun",
        "bubun",
        "addr",
        "gosi_year",
        "gosi_month",
        "jiga",
        "total",
        "current",
        "size",
        "page",
        "numOfRows",
        "totalCount",
        "crs",
    ];
    match value {
        Value::Object(object) => Value::Object(
            object
                .iter()
                .filter(|(key, _)| ALLOWED.contains(&key.as_str()))
                .map(|(key, value)| (key.clone(), sanitize_value(value)))
                .collect(),
        ),
        Value::Array(values) => Value::Array(values.iter().map(sanitize_value).collect()),
        Value::String(value) => Value::String(value.clone()),
        Value::Number(value) => Value::Number(value.clone()),
        Value::Bool(value) => Value::Bool(*value),
        Value::Null => Value::Null,
    }
}

#[tauri::command]
pub async fn vworld_search(
    state: tauri::State<'_, VWorldState>,
    request_id: String,
    request: SearchRequest,
) -> Result<VWorldResponse, String> {
    if request.query.trim().is_empty()
        || request.query.chars().count() > MAX_QUERY_CHARS
        || !valid_search_type(&request.search_type)
        || !valid_search_category(&request.search_type, request.category.as_deref())
    {
        return invalid();
    }
    if let Some(bbox) = request.bbox {
        if !valid_bbox(bbox) {
            return invalid();
        }
    }
    let size = page_size(request.size)?;
    let page = page_number(request.page)?;
    let (key, client) = with_credential(credential_key, |key| Ok((key, client()?)))?;
    let mut params = vec![
        ("key", key),
        ("service", "search".into()),
        ("version", "2.0".into()),
        ("request", "search".into()),
        ("format", "json".into()),
        ("errorFormat", "json".into()),
        ("query", query_value(&request.query)),
        ("type", request.search_type),
        ("size", size.to_string()),
        ("page", page.to_string()),
        ("crs", "EPSG:4326".into()),
    ];
    if let Some(category) = request.category {
        params.push(("category", category));
    }
    if let Some([min_x, min_y, max_x, max_y]) = request.bbox {
        params.push(("bbox", format!("{min_x},{min_y},{max_x},{max_y}")));
    }
    execute_json(
        &state,
        &request_id,
        client.get(endpoint_url(SEARCH_PATH)).query(&params),
    )
    .await
    .map(response_dto)
}

#[tauri::command]
pub async fn vworld_geocode(
    state: tauri::State<'_, VWorldState>,
    request_id: String,
    request: GeocodeRequest,
) -> Result<VWorldResponse, String> {
    if request.address.trim().is_empty()
        || request.address.chars().count() > MAX_ADDRESS_CHARS
        || !valid_address_type(&request.address_type)
    {
        return invalid();
    }
    let (key, client) = with_credential(credential_key, |key| Ok((key, client()?)))?;
    let cancel = register_geocoder_request(&state, &request_id)?;
    let params = [
        ("key", key),
        ("service", "address".into()),
        ("version", "2.0".into()),
        ("request", "GetCoord".into()),
        ("format", "json".into()),
        ("errorFormat", "json".into()),
        ("address", query_value(&request.address)),
        ("type", request.address_type),
        ("refine", request.refine.unwrap_or(true).to_string()),
        ("simple", request.simple.unwrap_or(false).to_string()),
        ("crs", "EPSG:4326".into()),
    ];
    execute_registered_json(
        &state,
        &request_id,
        cancel,
        client.get(endpoint_url(ADDRESS_PATH)).query(&params),
    )
    .await
    .map(response_dto)
}

#[tauri::command]
pub async fn vworld_reverse_geocode(
    state: tauri::State<'_, VWorldState>,
    request_id: String,
    request: ReverseGeocodeRequest,
) -> Result<VWorldResponse, String> {
    let [x, y] = request.point;
    if !finite(x) || !finite(y) || !(-180.0..=180.0).contains(&x) || !(-90.0..=90.0).contains(&y) {
        return invalid();
    }
    if let Some(t) = request.address_type.as_deref() {
        if !matches!(t, "ROAD" | "PARCEL" | "BOTH") {
            return invalid();
        }
    }
    let (key, client) = with_credential(credential_key, |key| Ok((key, client()?)))?;
    let cancel = register_geocoder_request(&state, &request_id)?;
    let params = [
        ("key", key),
        ("service", "address".into()),
        ("version", "2.0".into()),
        ("request", "GetAddress".into()),
        ("format", "json".into()),
        ("errorFormat", "json".into()),
        ("point", format!("{x},{y}")),
        (
            "type",
            request.address_type.unwrap_or_else(|| "BOTH".into()),
        ),
        ("zipcode", request.zipcode.unwrap_or(true).to_string()),
        ("simple", request.simple.unwrap_or(false).to_string()),
        ("crs", "EPSG:4326".into()),
    ];
    execute_registered_json(
        &state,
        &request_id,
        cancel,
        client.get(endpoint_url(ADDRESS_PATH)).query(&params),
    )
    .await
    .map(response_dto)
}

#[tauri::command]
pub async fn vworld_get_features(
    state: tauri::State<'_, VWorldState>,
    request_id: String,
    request: FeatureRequest,
) -> Result<VWorldResponse, String> {
    if !matches!(
        request.service.as_str(),
        "LP_PA_CBND_BUBUN" | "LT_C_UQ111" | "LT_C_UQ112" | "LT_C_UQ113" | "LT_C_UQ114"
    ) {
        return invalid();
    }
    let size = page_size(request.size)?;
    let page = page_number(request.page)?;
    if let Some(pnu) = request.pnu.as_deref() {
        if pnu.len() != 19 || !pnu.bytes().all(|b| b.is_ascii_digit()) {
            return invalid();
        }
    }
    if request.pnu.is_none() && request.geometry.is_none() {
        return invalid();
    }
    if request.pnu.is_some() && request.service != "LP_PA_CBND_BUBUN" {
        return invalid();
    }
    if let Some(g) = request.geometry.as_ref() {
        match g {
            GeometryFilter::Point {
                coordinates: [x, y],
            } => {
                if !finite(*x)
                    || !finite(*y)
                    || !(-180.0..=180.0).contains(x)
                    || !(-90.0..=90.0).contains(y)
                {
                    return invalid();
                }
            }
            GeometryFilter::Box { bounds } => {
                let [min_x, min_y, max_x, max_y] = *bounds;
                let mid_lat = (min_y + max_y) / 2.0;
                let area_km2 = (max_x - min_x).abs()
                    * 111.32
                    * mid_lat.to_radians().cos().abs()
                    * (max_y - min_y).abs()
                    * 110.57;
                if !valid_bbox(*bounds) || area_km2 > 2.0 {
                    return invalid();
                }
            }
        }
    }
    let (key, client) = with_credential(credential_key, |key| Ok((key, client()?)))?;
    let mut params = vec![
        ("key", key),
        ("service", "data".into()),
        ("version", "2.0".into()),
        ("request", "GetFeature".into()),
        ("format", "json".into()),
        ("errorFormat", "json".into()),
        ("data", request.service),
        ("size", size.to_string()),
        ("page", page.to_string()),
        ("crs", "EPSG:4326".into()),
    ];
    if let Some(pnu) = request.pnu {
        params.push(("attrFilter", format!("pnu:=:{pnu}")));
    }
    if let Some(g) = request.geometry {
        let text = match g {
            GeometryFilter::Point {
                coordinates: [x, y],
            } => format!("POINT({x} {y})"),
            GeometryFilter::Box {
                bounds: [min_x, min_y, max_x, max_y],
            } => format!("BOX({min_x},{min_y},{max_x},{max_y})"),
        };
        params.push(("geomFilter", text));
    }
    execute_json(
        &state,
        &request_id,
        client.get(endpoint_url(DATA_PATH)).query(&params),
    )
    .await
    .map(response_dto)
}

#[tauri::command]
pub async fn vworld_tile(
    state: tauri::State<'_, VWorldState>,
    request_id: String,
    request: TileRequest,
) -> Result<TileResponse, String> {
    if !valid_tile(&request) {
        return invalid();
    }
    let (key, client) = with_credential(credential_key, |key| Ok((key, client()?)))?;
    let mut cancel = register(&state, &request_id)?;
    let url = format!(
        "{API_BASE}/req/wmts/1.0.0/{key}/{}/{}/{}/{}.png",
        request.layer, request.z, request.y, request.x
    );
    let result = async {
        let response = tokio::select! {
            _ = &mut cancel => return Err(ERR_CANCELLED.into()),
            response = client.get(url).send() => response,
        };
        let response = response.map_err(|error| {
            if error.is_timeout() {
                ERR_TIMEOUT
            } else {
                ERR_NETWORK
            }
        })?;
        if !response.status().is_success() {
            return Err(ERR_HTTP.into());
        }
        let bytes = tokio::select! {
            _ = &mut cancel => return Err(ERR_CANCELLED.into()),
            bytes = read_limited(response, MAX_PNG_BYTES) => bytes?,
        };
        if bytes.len() < 8 || bytes[..8] != [137, 80, 78, 71, 13, 10, 26, 10] {
            return Err(ERR_PNG.into());
        }
        Ok(TileResponse {
            content_type: "image/png",
            bytes,
        })
    }
    .await;
    unregister(&state, &request_id);
    result
}

#[tauri::command]
pub fn vworld_cancel(
    state: tauri::State<'_, VWorldState>,
    request_id: String,
) -> Result<(), String> {
    if !valid_id(&request_id) {
        return Err(ERR_INVALID_REQUEST_ID.into());
    }
    cancel_request(&state, &request_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::Arc;
    use std::thread;
    use std::time::Duration;

    fn mock_response(
        status: &str,
        headers: Vec<(String, String)>,
        body: Vec<u8>,
        delay: Duration,
    ) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let status = status.to_string();
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 2048];
            let _ = stream.read(&mut request);
            thread::sleep(delay);
            let mut response = format!(
                "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n",
                body.len()
            );
            for (name, value) in headers {
                response.push_str(&format!("{name}: {value}\r\n"));
            }
            response.push_str("\r\n");
            if stream.write_all(response.as_bytes()).is_ok() {
                let _ = stream.write_all(&body);
            }
        });
        format!("http://{address}")
    }

    fn mock_delayed_body(body: Vec<u8>, delay: Duration) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 2048];
            let _ = stream.read(&mut request);
            let headers = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            if stream.write_all(headers.as_bytes()).is_ok() && stream.flush().is_ok() {
                thread::sleep(delay);
                let _ = stream.write_all(&body);
            }
        });
        format!("http://{address}")
    }

    #[test]
    fn request_ids_are_strict() {
        assert!(valid_id("abc-123_X"));
        assert!(!valid_id("../secret"));
        assert!(!valid_id(""));
    }
    #[test]
    fn search_categories_follow_the_official_type_contract() {
        assert!(valid_search_category("PLACE", None));
        assert!(valid_search_category("ROAD", None));
        assert!(valid_search_category("ADDRESS", Some("ROAD")));
        assert!(valid_search_category("DISTRICT", Some("L4")));
        assert!(!valid_search_category("ADDRESS", None));
        assert!(!valid_search_category("DISTRICT", None));
        assert!(!valid_search_category("PLACE", Some("ROAD")));
    }
    #[test]
    fn reverse_and_search_address_fields_survive_allowlist_sanitizing() {
        let sanitized = sanitize_value(&serde_json::json!({
            "item": [{ "road": "도로", "parcel": "지번", "secret": "drop" }]
        }));
        assert_eq!(sanitized["item"][0]["road"], "도로");
        assert_eq!(sanitized["item"][0]["parcel"], "지번");
        assert!(sanitized["item"][0].get("secret").is_none());
    }
    #[test]
    fn geocoder_daily_limit_is_memory_only_and_resets_on_utc_day_change() {
        let state = VWorldState::default();
        let utc_day = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()
            / 86_400;
        {
            let mut usage = state.geocoder_usage.lock().unwrap();
            usage.utc_day = utc_day;
            usage.count = DAILY_GEOCODER_LIMIT;
        }
        assert_eq!(reserve_geocoder_request(&state), Err(ERR_RATE_LIMIT.into()));
        {
            let mut usage = state.geocoder_usage.lock().unwrap();
            usage.utc_day = utc_day.saturating_sub(1);
        }
        assert!(reserve_geocoder_request(&state).is_ok());
        assert_eq!(state.geocoder_usage.lock().unwrap().count, 1);
    }
    #[test]
    fn invalid_and_duplicate_request_ids_do_not_consume_geocoder_quota() {
        let state = VWorldState::default();
        assert_eq!(
            register_geocoder_request(&state, "../invalid").unwrap_err(),
            ERR_INVALID_REQUEST_ID
        );
        assert_eq!(state.geocoder_usage.lock().unwrap().count, 0);

        let _active = register(&state, "duplicate").unwrap();
        assert_eq!(
            register_geocoder_request(&state, "duplicate").unwrap_err(),
            ERR_DUPLICATE_REQUEST_ID
        );
        assert_eq!(state.geocoder_usage.lock().unwrap().count, 0);
        unregister(&state, "duplicate");
    }
    #[test]
    fn quota_rejection_rolls_back_the_registered_request() {
        let state = VWorldState::default();
        let utc_day = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()
            / 86_400;
        {
            let mut usage = state.geocoder_usage.lock().unwrap();
            usage.utc_day = utc_day;
            usage.count = DAILY_GEOCODER_LIMIT;
        }
        assert_eq!(
            register_geocoder_request(&state, "quota-rejected").unwrap_err(),
            ERR_RATE_LIMIT
        );
        assert!(!state
            .requests
            .lock()
            .unwrap()
            .contains_key("quota-rejected"));
    }
    #[test]
    fn tile_allowlist_rejects_satellite_and_out_of_range_coordinates() {
        let satellite = TileRequest {
            layer: "Satellite".into(),
            z: 10,
            x: 0,
            y: 0,
        };
        let out_of_range = TileRequest {
            layer: "Base".into(),
            z: 10,
            x: 1024,
            y: 0,
        };
        let valid = TileRequest {
            layer: "Base".into(),
            z: 10,
            x: 1023,
            y: 1023,
        };
        let base_at_max_zoom = TileRequest {
            layer: "Base".into(),
            z: 19,
            x: 0,
            y: 0,
        };
        let hybrid_at_max_zoom = TileRequest {
            layer: "Hybrid".into(),
            z: 18,
            x: 0,
            y: 0,
        };
        let hybrid_above_max_zoom = TileRequest {
            layer: "Hybrid".into(),
            z: 19,
            x: 0,
            y: 0,
        };
        assert!(!valid_tile(&satellite));
        assert!(!valid_tile(&out_of_range));
        assert!(valid_tile(&valid));
        assert!(valid_tile(&base_at_max_zoom));
        assert!(valid_tile(&hybrid_at_max_zoom));
        assert!(!valid_tile(&hybrid_above_max_zoom));
    }
    #[test]
    fn coordinate_and_bbox_validation_is_bounded() {
        assert!(valid_bbox([1.0, 2.0, 2.0, 3.0]));
        assert!(!valid_bbox([2.0, 2.0, 1.0, 3.0]));
    }
    #[test]
    fn ipc_payloads_match_the_keyless_frontend_contract() {
        let search: SearchRequest = serde_json::from_value(serde_json::json!({
            "query": "판교", "type": "PLACE", "size": 10, "bbox": [126.0, 37.0, 128.0, 38.0]
        }))
        .unwrap();
        assert_eq!(search.search_type, "PLACE");
        let reverse: ReverseGeocodeRequest = serde_json::from_value(serde_json::json!({
            "point": [127.1, 37.4], "type": "BOTH"
        }))
        .unwrap();
        assert_eq!(reverse.point, [127.1, 37.4]);
        let features: FeatureRequest = serde_json::from_value(serde_json::json!({
            "service": "LP_PA_CBND_BUBUN", "pnu": "1111010100100020001"
        }))
        .unwrap();
        assert_eq!(features.service, "LP_PA_CBND_BUBUN");

        let tile = serde_json::to_value(TileResponse {
            content_type: "image/png",
            bytes: vec![137, 80, 78, 71],
        })
        .unwrap();
        assert_eq!(tile["contentType"], "image/png");
        assert!(tile.get("content_type").is_none());
    }

    #[test]
    fn fixed_endpoint_and_search_query_are_built_by_reqwest() {
        let request = client()
            .unwrap()
            .get(endpoint_url(SEARCH_PATH))
            .query(&[
                ("key", "test-key"),
                ("service", "search"),
                ("request", "search"),
                ("query", "판교"),
            ])
            .build()
            .unwrap();
        assert_eq!(request.url().scheme(), "https");
        assert_eq!(request.url().host_str(), Some("api.vworld.kr"));
        assert_eq!(request.url().path(), SEARCH_PATH);
        let query = request.url().query().unwrap();
        assert!(query.contains("service=search"));
        assert!(query.contains("request=search"));
        assert!(!query.contains(' '));
    }

    #[test]
    fn missing_credential_stops_before_request_building() {
        let request_built = Cell::new(false);
        let result: Result<(), String> = with_credential(
            || Err(ERR_MISSING_KEY.into()),
            |_| {
                request_built.set(true);
                Ok(())
            },
        );
        assert_eq!(result.unwrap_err(), ERR_MISSING_KEY);
        assert!(!request_built.get());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn mock_http_enforces_redirect_and_json_body_limit_with_cleanup() {
        let redirect_target = mock_response(
            "200 OK",
            vec![],
            br#"{"response":{"status":"OK"}}"#.to_vec(),
            Duration::ZERO,
        );
        let redirect = mock_response(
            "302 Found",
            vec![("Location".into(), redirect_target)],
            vec![],
            Duration::ZERO,
        );
        let state = VWorldState::default();
        let redirect_error = execute_json(&state, "redirect", client().unwrap().get(redirect))
            .await
            .unwrap_err();
        assert_eq!(redirect_error, ERR_HTTP);
        assert!(state.requests.lock().unwrap().is_empty());

        let oversized = mock_response(
            "200 OK",
            vec![("Content-Type".into(), "application/json".into())],
            vec![b'x'; MAX_JSON_BYTES + 1],
            Duration::ZERO,
        );
        let limit_error = execute_json(&state, "oversized", client().unwrap().get(oversized))
            .await
            .unwrap_err();
        assert_eq!(limit_error, ERR_RESPONSE);
        assert!(state.requests.lock().unwrap().is_empty());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn mock_http_maps_timeout_network_and_png_limit() {
        let delayed = mock_response(
            "200 OK",
            vec![],
            br#"{"response":{"status":"OK"}}"#.to_vec(),
            Duration::from_millis(100),
        );
        let short_client = reqwest::Client::builder()
            .timeout(Duration::from_millis(10))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let state = VWorldState::default();
        let timeout = execute_json(&state, "timeout", short_client.get(delayed))
            .await
            .unwrap_err();
        assert_eq!(timeout, ERR_TIMEOUT);

        let delayed_body = mock_delayed_body(
            br#"{\"response\":{\"status\":\"OK\"}}"#.to_vec(),
            Duration::from_millis(100),
        );
        let response = short_client.get(delayed_body).send().await.unwrap();
        assert_eq!(
            read_limited(response, MAX_JSON_BYTES).await.unwrap_err(),
            ERR_TIMEOUT
        );

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let closed = listener.local_addr().unwrap();
        drop(listener);
        let network = execute_json(
            &state,
            "network",
            client().unwrap().get(format!("http://{closed}")),
        )
        .await
        .unwrap_err();
        assert_eq!(network, ERR_NETWORK);

        let png = mock_response(
            "200 OK",
            vec![("Content-Type".into(), "image/png".into())],
            vec![0_u8; 9],
            Duration::ZERO,
        );
        let response = client().unwrap().get(png).send().await.unwrap();
        assert_eq!(read_limited(response, 8).await.unwrap_err(), ERR_RESPONSE);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn mock_http_cancellation_aborts_and_cleans_registry() {
        let delayed = mock_response(
            "200 OK",
            vec![],
            br#"{"response":{"status":"OK"}}"#.to_vec(),
            Duration::from_secs(1),
        );
        let state = Arc::new(VWorldState::default());
        let task_state = Arc::clone(&state);
        let task = tokio::spawn(async move {
            execute_json(&task_state, "cancel-me", client().unwrap().get(delayed)).await
        });

        for _ in 0..100 {
            if state.requests.lock().unwrap().contains_key("cancel-me") {
                break;
            }
            tokio::task::yield_now().await;
        }
        cancel_request(&state, "cancel-me").unwrap();
        assert_eq!(task.await.unwrap().unwrap_err(), ERR_CANCELLED);
        assert!(state.requests.lock().unwrap().is_empty());
    }
    #[test]
    fn cancellation_registry_rejects_duplicate_and_cleans() {
        let state = VWorldState::default();
        let _rx = register(&state, "same").unwrap();
        assert_eq!(
            register(&state, "same").unwrap_err(),
            ERR_DUPLICATE_REQUEST_ID
        );
        unregister(&state, "same");
        assert!(register(&state, "same").is_ok());
    }
    #[test]
    fn response_redaction_does_not_copy_unknown_nested_body() {
        let dto = response_dto(
            serde_json::json!({"response":{"status":"OK","page":{"total":1,"secret":"hidden"},"result":{"items":[{"title":"ok","secret":"do-not-expose","structure":{"level1":"경기도","token":"hidden"}}],"raw":"hidden"}}}),
        );
        assert_eq!(dto.status, "OK");
        let item = &dto.result.as_ref().unwrap()["items"][0];
        assert!(item.get("secret").is_none());
        assert!(item["structure"].get("token").is_none());
        assert!(dto.page.as_ref().unwrap().get("secret").is_none());
        assert!(dto.result.as_ref().unwrap().get("raw").is_none());
    }
}
