//! Dedicated HTTPS transport policy for external scene resources.
//!
//! This module intentionally has no Tauri commands and no renderer-facing URL
//! handling.  It is the policy/orchestration boundary for the future Windows
//! native client.  A real transport must connect to `peer_ip` directly, use
//! `hostname` only for TLS SNI/hostname verification, and use the OS root trust
//! store.  The supplied production seam fails closed until such a binding is
//! available; it must not silently fall back to a normal hostname client.

use std::future::Future;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use reqwest::Url;
use tokio::sync::Semaphore;

pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
pub const MAX_CONCURRENT: usize = 8;
pub const MAX_RESOURCE_BYTES: usize = 256 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemoteError {
    InvalidUrl,
    InvalidScheme,
    InvalidHost,
    PrivateDestination,
    DnsFailure,
    NoGlobalAddress,
    Redirect,
    BodyTooLarge,
    Timeout,
    Cancelled,
    Busy,
    HttpStatus,
    TransportUnavailable,
    TlsFailure,
    Internal,
}

impl RemoteError {
    pub const fn code(self) -> &'static str {
        match self {
            Self::InvalidUrl
            | Self::InvalidScheme
            | Self::InvalidHost
            | Self::PrivateDestination
            | Self::NoGlobalAddress
            | Self::Redirect
            | Self::TlsFailure => "SCENE_PRESET_REFERENCE_INVALID",
            Self::DnsFailure | Self::Timeout | Self::HttpStatus | Self::TransportUnavailable => {
                "SCENE_PRESET_REMOTE_UNAVAILABLE"
            }
            Self::BodyTooLarge | Self::Busy => "SCENE_PRESET_LIMIT_EXCEEDED",
            Self::Cancelled => "SCENE_PRESET_CANCELLED",
            Self::Internal => "SCENE_PRESET_INTERNAL",
        }
    }
}

impl std::fmt::Display for RemoteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.code())
    }
}

impl std::error::Error for RemoteError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedUrl {
    url: Url,
    hostname: String,
}

impl ValidatedUrl {
    pub fn parse(value: &str) -> Result<Self, RemoteError> {
        reject_raw_path_traversal(value)?;
        let url = Url::parse(value).map_err(|_| RemoteError::InvalidUrl)?;
        if url.scheme() != "https" {
            return Err(RemoteError::InvalidScheme);
        }
        if url.port().is_some_and(|port| port != 443) {
            return Err(RemoteError::InvalidScheme);
        }
        if !url.username().is_empty() || url.password().is_some() || url.query().is_some() {
            return Err(RemoteError::InvalidUrl);
        }
        if url.fragment().is_some() {
            return Err(RemoteError::InvalidUrl);
        }
        let hostname = url
            .host_str()
            .ok_or(RemoteError::InvalidHost)?
            .to_ascii_lowercase();
        if hostname.is_empty()
            || hostname == "localhost"
            || hostname.ends_with(".local")
            || hostname.parse::<IpAddr>().is_ok()
            || hostname.contains(':')
        {
            return Err(RemoteError::InvalidHost);
        }
        reject_path_traversal(url.path())?;
        Ok(Self { url, hostname })
    }

    pub fn url(&self) -> &Url {
        &self.url
    }
    pub fn hostname(&self) -> &str {
        &self.hostname
    }

    pub fn nested(&self, value: &str) -> Result<Url, RemoteError> {
        reject_raw_path_traversal(value)?;
        let child = if value.contains("://") {
            Url::parse(value).map_err(|_| RemoteError::InvalidUrl)?
        } else {
            self.url.join(value).map_err(|_| RemoteError::InvalidUrl)?
        };
        reject_path_traversal(child.path())?;
        if !same_origin(self.url(), &child) {
            return Err(RemoteError::InvalidHost);
        }
        Ok(child)
    }
}

fn reject_raw_path_traversal(value: &str) -> Result<(), RemoteError> {
    let lower = value.to_ascii_lowercase();
    let path = lower
        .split_once("://")
        .and_then(|(_, rest)| rest.split_once('/').map(|(_, path)| path))
        .unwrap_or("");
    let path = path.split(['?', '#']).next().unwrap_or(path);
    if path.split('/').any(|part| part == "." || part == "..")
        || path.contains("%2e")
        || path.contains("%2f")
        || path.contains("%5c")
    {
        return Err(RemoteError::InvalidUrl);
    }
    Ok(())
}

fn reject_path_traversal(path: &str) -> Result<(), RemoteError> {
    // Reject encoded separators/dots before any URL implementation can normalize them.
    let lower = path.to_ascii_lowercase();
    if lower.contains("%2e") || lower.contains("%2f") || lower.contains("%5c") {
        return Err(RemoteError::InvalidUrl);
    }
    if path.split('/').any(|part| part == "." || part == "..") {
        return Err(RemoteError::InvalidUrl);
    }
    Ok(())
}

pub fn same_origin(a: &Url, b: &Url) -> bool {
    a.scheme().eq_ignore_ascii_case(b.scheme())
        && a.host_str().is_some_and(|host| {
            b.host_str()
                .is_some_and(|other| host.eq_ignore_ascii_case(other))
        })
        && a.port_or_known_default() == b.port_or_known_default()
}

pub fn is_global_unicast(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => is_global_v4(ip),
        IpAddr::V6(ip) => is_global_v6(ip),
    }
}

fn is_global_v4(ip: Ipv4Addr) -> bool {
    let octets = ip.octets();
    !(ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_broadcast()
        || ip.is_documentation()
        || octets[0] == 0
        || octets[0] >= 224
        || (octets[0] == 100 && (64..=127).contains(&octets[1]))
        || (octets[0] == 169 && octets[1] == 254))
}

fn is_global_v6(ip: Ipv6Addr) -> bool {
    let segments = ip.segments();
    !(ip.is_loopback()
        || ip.is_unspecified()
        || ip.is_unique_local()
        || ip.is_unicast_link_local()
        || (segments[0] & 0xffc0) == 0xfe80
        || (segments[0] & 0xff00) == 0xff00
        || ip
            .to_ipv4_mapped()
            .is_some_and(|mapped| !is_global_v4(mapped)))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedPeer {
    pub hostname: String,
    pub peer_ip: IpAddr,
}

pub trait Resolver: Send + Sync {
    fn resolve(
        &self,
        hostname: String,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<IpAddr>, RemoteError>> + Send>>;
}

pub struct SystemResolver;

impl Resolver for SystemResolver {
    fn resolve(
        &self,
        hostname: String,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<IpAddr>, RemoteError>> + Send>> {
        Box::pin(async move {
            use std::net::ToSocketAddrs;
            let addresses = (hostname.as_str(), 443)
                .to_socket_addrs()
                .map_err(|_| RemoteError::DnsFailure)?
                .map(|address| address.ip())
                .collect::<Vec<_>>();
            Ok(addresses)
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransportRequest {
    pub url: Url,
    pub hostname: String,
    pub peer_ip: IpAddr,
    pub redirect_policy_none: bool,
    pub cookie_jar_disabled: bool,
    pub proxy_disabled: bool,
    pub client_cert_disabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransportResponse {
    pub status: u16,
    pub body: Vec<u8>,
}

pub trait Transport: Send + Sync {
    fn send(
        &self,
        request: TransportRequest,
    ) -> Pin<Box<dyn Future<Output = Result<TransportResponse, RemoteError>> + Send>>;
}

/// There is deliberately no unsafe “best effort” fallback.  The eventual
/// implementation must prove direct socket peer pinning and TLS hostname/SNI
/// verification before this seam can be replaced.
pub struct FailClosedTransport;

impl Transport for FailClosedTransport {
    fn send(
        &self,
        _request: TransportRequest,
    ) -> Pin<Box<dyn Future<Output = Result<TransportResponse, RemoteError>> + Send>> {
        Box::pin(async { Err(RemoteError::TransportUnavailable) })
    }
}

pub struct RemoteTransport<R, T> {
    resolver: Arc<R>,
    transport: Arc<T>,
    slots: Arc<Semaphore>,
    timeout: Duration,
}

impl<R: Resolver + 'static, T: Transport + 'static> RemoteTransport<R, T> {
    pub fn new(resolver: Arc<R>, transport: Arc<T>) -> Self {
        Self {
            resolver,
            transport,
            slots: Arc::new(Semaphore::new(MAX_CONCURRENT)),
            timeout: REQUEST_TIMEOUT,
        }
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    pub async fn fetch<F>(&self, url: &str, cancel: F) -> Result<Vec<u8>, RemoteError>
    where
        F: Future<Output = ()> + Send,
    {
        let validated = ValidatedUrl::parse(url)?;
        tokio::pin!(cancel);
        let permit = self
            .slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| RemoteError::Busy)?;
        let addresses = tokio::select! {
            _ = &mut cancel => return Err(RemoteError::Cancelled),
            result = tokio::time::timeout(self.timeout, self.resolver.resolve(validated.hostname().to_owned())) => {
                result.map_err(|_| RemoteError::Timeout)??
            }
        };
        if addresses.is_empty() || addresses.iter().any(|ip| !is_global_unicast(*ip)) {
            return Err(RemoteError::NoGlobalAddress);
        }
        let peer_ip = addresses[0];
        let request = TransportRequest {
            url: validated.url().clone(),
            hostname: validated.hostname().to_owned(),
            peer_ip,
            redirect_policy_none: true,
            cookie_jar_disabled: true,
            proxy_disabled: true,
            client_cert_disabled: true,
        };
        let response = tokio::select! {
            _ = &mut cancel => return Err(RemoteError::Cancelled),
            result = tokio::time::timeout(self.timeout, self.transport.send(request)) => {
                result.map_err(|_| RemoteError::Timeout)?
            }
        }?;
        drop(permit);
        if (300..400).contains(&response.status) {
            return Err(RemoteError::Redirect);
        }
        if !(200..300).contains(&response.status) {
            return Err(RemoteError::HttpStatus);
        }
        if response.body.len() > MAX_RESOURCE_BYTES {
            return Err(RemoteError::BodyTooLarge);
        }
        Ok(response.body)
    }

    pub async fn validate_nested(&self, root: &str, nested: &str) -> Result<Url, RemoteError> {
        ValidatedUrl::parse(root)?.nested(nested)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use tokio::time::sleep;

    struct MockResolver {
        addresses: Vec<IpAddr>,
    }
    impl Resolver for MockResolver {
        fn resolve(
            &self,
            _hostname: String,
        ) -> Pin<Box<dyn Future<Output = Result<Vec<IpAddr>, RemoteError>> + Send>> {
            let addresses = self.addresses.clone();
            Box::pin(async move { Ok(addresses) })
        }
    }

    struct MockTransport {
        response: Mutex<Option<Result<TransportResponse, RemoteError>>>,
        seen: Mutex<Vec<TransportRequest>>,
        delay: Duration,
    }
    impl Transport for MockTransport {
        fn send(
            &self,
            request: TransportRequest,
        ) -> Pin<Box<dyn Future<Output = Result<TransportResponse, RemoteError>> + Send>> {
            self.seen.lock().unwrap().push(request);
            let response = self
                .response
                .lock()
                .unwrap()
                .take()
                .unwrap_or(Err(RemoteError::Internal));
            let delay = self.delay;
            Box::pin(async move {
                sleep(delay).await;
                response
            })
        }
    }

    fn service(
        response: Result<TransportResponse, RemoteError>,
    ) -> (
        RemoteTransport<MockResolver, MockTransport>,
        Arc<MockTransport>,
    ) {
        let transport = Arc::new(MockTransport {
            response: Mutex::new(Some(response)),
            seen: Mutex::new(Vec::new()),
            delay: Duration::ZERO,
        });
        let resolver = Arc::new(MockResolver {
            addresses: vec!["93.184.216.34".parse().unwrap()],
        });
        (RemoteTransport::new(resolver, transport.clone()), transport)
    }

    #[test]
    fn rejects_invalid_scheme_ip_literal_and_localhost() {
        assert_eq!(
            ValidatedUrl::parse("http://example.test/").unwrap_err(),
            RemoteError::InvalidScheme
        );
        for value in ["https://127.0.0.1/", "https://[::1]/", "https://localhost/"] {
            assert_eq!(
                ValidatedUrl::parse(value).unwrap_err(),
                RemoteError::InvalidHost
            );
        }
    }

    #[test]
    fn rejects_private_and_reserved_addresses() {
        for value in [
            "10.0.0.1",
            "172.16.0.1",
            "192.168.1.1",
            "169.254.1.1",
            "127.0.0.1",
            "100.64.0.1",
            "224.0.0.1",
            "::1",
            "fc00::1",
            "fe80::1",
        ] {
            assert!(!is_global_unicast(value.parse().unwrap()), "{value}");
        }
    }

    #[tokio::test]
    async fn rejects_private_dns_if_any_answer_is_not_global() {
        let transport = Arc::new(MockTransport {
            response: Mutex::new(Some(Ok(TransportResponse {
                status: 200,
                body: vec![1],
            }))),
            seen: Mutex::new(Vec::new()),
            delay: Duration::ZERO,
        });
        let resolver = Arc::new(MockResolver {
            addresses: vec![
                "93.184.216.34".parse().unwrap(),
                "192.168.1.1".parse().unwrap(),
            ],
        });
        let service = RemoteTransport::new(resolver, transport);
        // DNS policy is fail-closed if any answer is private, not merely if one public answer exists.
        assert_eq!(
            service
                .fetch("https://example.test/a", std::future::pending())
                .await
                .unwrap_err(),
            RemoteError::NoGlobalAddress
        );
    }

    #[tokio::test]
    async fn rejects_redirect_and_oversized_body_without_value_errors() {
        let (redirect_service, _) = service(Ok(TransportResponse {
            status: 302,
            body: Vec::new(),
        }));
        assert_eq!(
            redirect_service
                .fetch("https://example.test/a", std::future::pending())
                .await
                .unwrap_err(),
            RemoteError::Redirect
        );
        let (large_service, _) = service(Ok(TransportResponse {
            status: 200,
            body: vec![0; MAX_RESOURCE_BYTES + 1],
        }));
        assert_eq!(
            large_service
                .fetch("https://example.test/a", std::future::pending())
                .await
                .unwrap_err(),
            RemoteError::BodyTooLarge
        );
    }

    #[test]
    fn rejects_cross_origin_and_traversal_nested_urls() {
        let root = ValidatedUrl::parse("https://example.test/root/asset.glb").unwrap();
        assert!(root.nested("https://other.test/root/asset.bin").is_err());
        assert!(root
            .nested("https://example.test/root/../secret.bin")
            .is_err());
        assert!(root
            .nested("https://example.test/root/%2e%2e/secret.bin")
            .is_err());
        assert!(root.nested("https://example.test/root/asset.bin").is_ok());
        assert_eq!(
            root.nested("asset.bin").unwrap().as_str(),
            "https://example.test/root/asset.bin"
        );
    }

    #[tokio::test]
    async fn pins_one_global_ip_and_disables_ambient_features() {
        let (service, transport) = service(Ok(TransportResponse {
            status: 200,
            body: vec![7],
        }));
        assert_eq!(
            service
                .fetch("https://example.test/a", std::future::pending())
                .await
                .unwrap(),
            vec![7]
        );
        let request = &transport.seen.lock().unwrap()[0];
        assert_eq!(request.peer_ip, "93.184.216.34".parse::<IpAddr>().unwrap());
        assert!(
            request.redirect_policy_none
                && request.cookie_jar_disabled
                && request.proxy_disabled
                && request.client_cert_disabled
        );
    }

    #[tokio::test]
    async fn timeout_and_cancel_are_distinct_stable_errors() {
        let transport = Arc::new(MockTransport {
            response: Mutex::new(Some(Ok(TransportResponse {
                status: 200,
                body: vec![1],
            }))),
            seen: Mutex::new(Vec::new()),
            delay: Duration::from_millis(50),
        });
        let resolver = Arc::new(MockResolver {
            addresses: vec!["93.184.216.34".parse().unwrap()],
        });
        let timeout_service =
            RemoteTransport::new(resolver, transport).with_timeout(Duration::from_millis(1));
        assert_eq!(
            timeout_service
                .fetch("https://example.test/a", std::future::pending())
                .await
                .unwrap_err(),
            RemoteError::Timeout
        );
        let (cancel_service, _) = service(Ok(TransportResponse {
            status: 200,
            body: vec![1],
        }));
        assert_eq!(
            cancel_service
                .fetch("https://example.test/a", async {})
                .await
                .unwrap_err(),
            RemoteError::Cancelled
        );
    }

    #[tokio::test]
    async fn fail_closed_transport_reports_no_binding() {
        let resolver = Arc::new(MockResolver {
            addresses: vec!["93.184.216.34".parse().unwrap()],
        });
        let service = RemoteTransport::new(resolver, Arc::new(FailClosedTransport));
        assert_eq!(
            service
                .fetch("https://example.test/a", std::future::pending())
                .await
                .unwrap_err(),
            RemoteError::TransportUnavailable
        );
    }
}
