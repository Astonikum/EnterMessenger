use serde::{Deserialize, Serialize};

pub const PROTOCOL_NAME: &str = "enter";
pub const PROTOCOL_VERSION: &str = "enter/0.2";

#[derive(Serialize)]
pub struct DiscoveryDocument {
    pub protocol: &'static str,
    pub version: &'static str,
    pub server: String,
    #[serde(rename = "serverId")]
    pub server_id: String,
    pub name: String,
    pub logo: Option<String>,
    pub capabilities: Vec<&'static str>,
    pub endpoints: DiscoveryEndpoints,
    pub crypto: CryptoProfile,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryEndpoints {
    pub keys: &'static str,
    pub realtime: &'static str,
    pub media_upload: &'static str,
    pub media_download: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CryptoProfile {
    pub identity_signature: &'static str,
    pub key_agreement: &'static str,
    pub direct_sessions: &'static str,
    pub groups: &'static str,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct EncryptedEnvelope {
    pub protocol: String,
    pub message_id: String,
    pub conversation_id: String,
    pub sender: String,
    pub recipient: String,
    pub sender_device: String,
    pub key_id: String,
    pub created_at: String,
    pub nonce: String,
    pub ephemeral_public_key: String,
    pub ciphertext: String,
    pub associated_data: String,
    pub signature: String,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DeviceKeyBundle {
    pub device_id: String,
    pub key_id: String,
    pub encryption_public_key: String,
    pub signing_public_key: String,
    pub created_at: i64,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AccountKeyBundle {
    pub key_id: String,
    pub encryption_public_key: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicKeyDirectory {
    pub id: String,
    pub handle: String,
    pub name: String,
    pub server: String,
    #[serde(rename = "serverId")]
    pub server_id: String,
    pub devices: Vec<DeviceKeyBundle>,
    pub account_key: Option<AccountKeyBundle>,
}

pub fn discovery(
    server_url: String,
    server_id: String,
    name: String,
    logo: Option<String>,
) -> DiscoveryDocument {
    DiscoveryDocument {
        protocol: PROTOCOL_NAME,
        version: PROTOCOL_VERSION,
        server: server_url,
        server_id,
        name,
        logo,
        capabilities: vec![
            "directory",
            "message-relay",
            "encrypted-messages",
            "encrypted-media",
            "realtime",
        ],
        endpoints: DiscoveryEndpoints {
            keys: "/enter/v1/keys/{handle}",
            realtime: "/api/v1/realtime",
            media_upload: "/api/v1/media",
            media_download: "/api/v1/media/{media_id}",
        },
        crypto: CryptoProfile {
            identity_signature: "ECDSA-P256-SHA256",
            key_agreement: "ECDH-P256",
            direct_sessions: "ephemeral ECDH + AES-256-GCM",
            groups: "not-enabled",
        },
    }
}

pub fn is_supported_envelope(envelope: &EncryptedEnvelope) -> bool {
    envelope.protocol == PROTOCOL_VERSION
        && valid_identifier(&envelope.message_id)
        && valid_identifier(&envelope.conversation_id)
        && valid_address(&envelope.sender)
        && valid_address(&envelope.recipient)
        && valid_identifier(&envelope.sender_device)
        && valid_identifier(&envelope.key_id)
        && valid_timestamp(&envelope.created_at)
        && valid_encoded(&envelope.nonce, 128)
        && valid_encoded(&envelope.ephemeral_public_key, 16_384)
        && valid_encoded(&envelope.associated_data, 16_384)
        && valid_encoded(&envelope.ciphertext, 1_500_000)
        && valid_encoded(&envelope.signature, 512)
}

pub fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
}

pub fn valid_handle(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn valid_server(value: &str) -> bool {
    if value.is_empty() || value.len() > 255 {
        return false;
    }
    let (host, port) = if let Some(rest) = value.strip_prefix('[') {
        let Some((host, port)) = rest.split_once("]:") else {
            return false;
        };
        (host, Some(port))
    } else if let Some((host, port)) = value.rsplit_once(':') {
        if host.contains(':') {
            return false;
        }
        (host, Some(port))
    } else {
        (value, None)
    };
    if host.is_empty() || host.contains("..") {
        return false;
    }
    let valid_host = if value.starts_with('[') {
        host.bytes()
            .all(|byte| byte.is_ascii_hexdigit() || byte == b':')
    } else {
        host.bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-'))
    };
    let valid_port = port.is_none_or(|port| {
        !port.is_empty()
            && port.len() <= 5
            && port.bytes().all(|byte| byte.is_ascii_digit())
            && port.parse::<u16>().is_ok_and(|value| value > 0)
    });
    valid_host && valid_port
}

pub fn valid_address(value: &str) -> bool {
    let Some((handle, server)) = value.rsplit_once('@') else {
        return false;
    };
    valid_handle(handle) && valid_server(server) && !server.contains('@')
}

fn valid_timestamp(value: &str) -> bool {
    value.len() <= 64
        && value.contains('T')
        && value.bytes().all(|byte| {
            byte.is_ascii_digit() || matches!(byte, b'T' | b'Z' | b'+' | b'-' | b':' | b'.')
        })
}

fn valid_encoded(value: &str, max_len: usize) -> bool {
    !value.is_empty()
        && value.len() <= max_len
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'=' | b'-' | b'_')
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn envelope() -> EncryptedEnvelope {
        EncryptedEnvelope {
            protocol: PROTOCOL_VERSION.to_owned(),
            message_id: "message-1".to_owned(),
            conversation_id: "conversation-1".to_owned(),
            sender: "alice@example.test".to_owned(),
            recipient: "bob@example.test".to_owned(),
            sender_device: "device-1".to_owned(),
            key_id: "key-1".to_owned(),
            created_at: "2026-08-16T00:00:00Z".to_owned(),
            nonce: "nonce".to_owned(),
            ephemeral_public_key: "ephemeral-public-key".to_owned(),
            ciphertext: "ciphertext".to_owned(),
            associated_data: "aad".to_owned(),
            signature: "signature".to_owned(),
        }
    }

    #[test]
    fn accepts_complete_current_envelope() {
        assert!(is_supported_envelope(&envelope()));
    }

    #[test]
    fn rejects_plaintext_only_delivery() {
        let mut value = envelope();
        value.ciphertext.clear();
        assert!(!is_supported_envelope(&value));
    }

    #[test]
    fn rejects_malformed_or_oversized_envelope_fields() {
        let mut value = envelope();
        value.sender = "alice@example.test/path".to_owned();
        assert!(!is_supported_envelope(&value));

        let mut value = envelope();
        value.message_id = "x".repeat(129);
        assert!(!is_supported_envelope(&value));

        let mut value = envelope();
        value.ciphertext = "!".to_owned();
        assert!(!is_supported_envelope(&value));
    }

    #[test]
    fn discovery_does_not_advertise_unsupported_federation() {
        let document = discovery(
            "https://example.test".to_owned(),
            "server-1".to_owned(),
            "Enter".to_owned(),
            None,
        );
        assert!(!document.capabilities.contains(&"federation"));
        let value = serde_json::to_value(document).expect("serialize discovery");
        assert!(value["endpoints"].get("federationDelivery").is_none());
    }
}
