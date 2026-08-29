use std::{
    env,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::PathBuf,
};

pub const DEFAULT_MEDIA_MAX_BYTES: usize = 200 * 1024 * 1024;
const MEDIA_MAX_BYTES_PER_MB: u64 = 1024 * 1024;

#[derive(Clone)]
pub struct ServerConfig {
    pub public_url: String,
    pub name: String,
    pub logo_url: Option<String>,
    pub logo_path: Option<PathBuf>,
    pub database_url: String,
    pub expo_push_url: String,
    /// Shared secret used to authenticate server-to-server delivery.
    pub federation_secret: Option<String>,
    /// HTTP is useful for local/LAN development only; production should use HTTPS.
    pub federation_allow_http: bool,
    /// Maximum plaintext media size. The upload body may be 16 bytes larger for AES-GCM auth data.
    pub media_max_bytes: usize,
    pub address: SocketAddr,
}

impl ServerConfig {
    pub fn from_env() -> Self {
        let public_url = env::var("ENTER_SERVER_URL")
            .unwrap_or_else(|_| "http://127.0.0.1:50121".to_owned())
            .trim_end_matches('/')
            .to_owned();
        let name = env::var("ENTER_SERVER_NAME")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "Enter".to_owned());
        let logo_url = env::var("ENTER_SERVER_LOGO_URL")
            .ok()
            .filter(|value| !value.trim().is_empty());
        let logo_path = env::var("ENTER_SERVER_LOGO_PATH")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .map(PathBuf::from);
        let database_url = env::var("ENTER_DATABASE_URL").unwrap_or_else(|_| {
            let path = env::var("ENTER_DB_PATH")
                .unwrap_or_else(|_| "server/data/enter.sqlite3".to_owned());
            if path.starts_with("sqlite:") {
                path
            } else {
                format!("sqlite://{path}")
            }
        });
        let expo_push_url = env::var("ENTER_EXPO_PUSH_URL")
            .unwrap_or_else(|_| "https://exp.host/--/api/v2/push/send".to_owned())
            .trim_end_matches('/')
            .to_owned();
        let federation_secret = env::var("ENTER_FEDERATION_SECRET")
            .ok()
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty());
        let federation_allow_http =
            parse_bool(env::var("ENTER_FEDERATION_ALLOW_HTTP").ok().as_deref());
        let media_max_bytes = media_limit_bytes(env::var("ENTER_MEDIA_MAX_MB").ok().as_deref());
        let port = env::var("ENTER_PORT")
            .ok()
            .and_then(|value| value.parse::<u16>().ok())
            .unwrap_or(50121);
        let bind_address = configured_address(env::var("ENTER_BIND_ADDRESS").ok().as_deref(), port);

        Self {
            public_url,
            name,
            logo_url,
            logo_path,
            database_url,
            expo_push_url,
            federation_secret,
            federation_allow_http,
            media_max_bytes,
            address: bind_address,
        }
    }

    pub fn logo(&self) -> Option<String> {
        self.logo_url.clone().or_else(|| {
            self.logo_path
                .as_ref()
                .map(|_| format!("{}/server/logo", self.public_url))
        })
    }
}

fn media_limit_bytes(value: Option<&str>) -> usize {
    value
        .and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|megabytes| *megabytes > 0)
        .and_then(|megabytes| megabytes.checked_mul(MEDIA_MAX_BYTES_PER_MB))
        .and_then(|bytes| usize::try_from(bytes).ok())
        .unwrap_or(DEFAULT_MEDIA_MAX_BYTES)
}

fn configured_address(value: Option<&str>, port: u16) -> SocketAddr {
    let address = value
        .and_then(|value| value.parse::<IpAddr>().ok())
        .unwrap_or(IpAddr::V4(Ipv4Addr::UNSPECIFIED));
    SocketAddr::new(address, port)
}

fn parse_bool(value: Option<&str>) -> bool {
    value.is_some_and(|value| {
        matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bind_defaults_to_all_ipv4_interfaces() {
        assert_eq!(
            configured_address(None, 50121),
            SocketAddr::from(([0, 0, 0, 0], 50121))
        );
    }

    #[test]
    fn bind_accepts_lan_address() {
        assert_eq!(
            configured_address(Some("0.0.0.0"), 50121),
            SocketAddr::from(([0, 0, 0, 0], 50121))
        );
    }

    #[test]
    fn bind_rejects_invalid_address() {
        assert_eq!(
            configured_address(Some("not-an-ip"), 50121),
            SocketAddr::from(([0, 0, 0, 0], 50121))
        );
    }

    #[test]
    fn media_limit_defaults_to_200_mb_and_accepts_custom_mb() {
        assert_eq!(media_limit_bytes(None), 200 * 1024 * 1024);
        assert_eq!(media_limit_bytes(Some("32")), 32 * 1024 * 1024);
        assert_eq!(media_limit_bytes(Some("invalid")), 200 * 1024 * 1024);
        assert_eq!(media_limit_bytes(Some("0")), 200 * 1024 * 1024);
    }

    #[test]
    fn federation_http_is_opt_in() {
        assert!(!parse_bool(None));
        assert!(!parse_bool(Some("false")));
        assert!(parse_bool(Some("true")));
        assert!(parse_bool(Some(" ON ")));
    }
}
