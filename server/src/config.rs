use std::{
    env,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::PathBuf,
};

#[derive(Clone)]
pub struct ServerConfig {
    pub public_url: String,
    pub name: String,
    pub logo_url: Option<String>,
    pub logo_path: Option<PathBuf>,
    pub database_url: String,
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

fn configured_address(value: Option<&str>, port: u16) -> SocketAddr {
    let address = value
        .and_then(|value| value.parse::<IpAddr>().ok())
        .unwrap_or(IpAddr::V4(Ipv4Addr::LOCALHOST));
    SocketAddr::new(address, port)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bind_defaults_to_loopback() {
        assert_eq!(
            configured_address(None, 50121),
            SocketAddr::from(([127, 0, 0, 1], 50121))
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
            SocketAddr::from(([127, 0, 0, 1], 50121))
        );
    }
}
