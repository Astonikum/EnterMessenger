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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub federation_delivery: Option<&'static str>,
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
pub struct EncryptedMessage {
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

/// A user-visible message carried between home servers. The encrypted message
/// is deliberately nested so transport metadata is not confused with a message.
#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FederationMessage {
    pub id: String,
    pub conversation_id: String,
    pub created_at: i64,
    pub encrypted_message: EncryptedMessage,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FederationDelivery {
    pub protocol: String,
    pub delivery_id: String,
    pub sender_server: String,
    pub sender_name: String,
    pub sender_avatar: String,
    pub message: FederationMessage,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FederationDeliveryResponse {
    pub protocol: &'static str,
    pub delivery_id: String,
    pub accepted: bool,
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
    federation_enabled: bool,
) -> DiscoveryDocument {
    let mut capabilities = vec![
        "directory",
        "message-relay",
        "encrypted-messages",
        "encrypted-media",
        "realtime",
    ];
    if federation_enabled {
        capabilities.insert(2, "federation");
    }
    DiscoveryDocument {
        protocol: PROTOCOL_NAME,
        version: PROTOCOL_VERSION,
        server: server_url,
        server_id,
        name,
        logo,
        capabilities,
        endpoints: DiscoveryEndpoints {
            keys: "/enter/v1/keys/{handle}",
            federation_delivery: federation_enabled.then_some("/enter/v1/federation/deliveries"),
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

pub fn is_supported_message(encrypted_message: &EncryptedMessage) -> bool {
    encrypted_message.protocol == PROTOCOL_VERSION
        && valid_identifier(&encrypted_message.message_id)
        && valid_identifier(&encrypted_message.conversation_id)
        && valid_address(&encrypted_message.sender)
        && valid_address(&encrypted_message.recipient)
        && valid_identifier(&encrypted_message.sender_device)
        && valid_identifier(&encrypted_message.key_id)
        && valid_timestamp(&encrypted_message.created_at)
        && valid_encoded(&encrypted_message.nonce, 128)
        && valid_encoded(&encrypted_message.ephemeral_public_key, 16_384)
        && valid_encoded(&encrypted_message.associated_data, 16_384)
        && valid_encoded(&encrypted_message.ciphertext, 1_500_000)
        && valid_encoded(&encrypted_message.signature, 512)
}

pub fn is_supported_delivery(delivery: &FederationDelivery) -> bool {
    delivery.protocol == PROTOCOL_VERSION
        && valid_delivery_identifier(&delivery.delivery_id)
        && valid_server_reference(&delivery.sender_server)
        && valid_display_text(&delivery.sender_name, 160)
        && valid_display_text(&delivery.sender_avatar, 320)
        && valid_identifier(&delivery.message.id)
        && valid_identifier(&delivery.message.conversation_id)
        && delivery.message.created_at > 0
        && delivery.message.id == delivery.message.encrypted_message.message_id
        && delivery.message.conversation_id == delivery.message.encrypted_message.conversation_id
        && is_supported_message(&delivery.message.encrypted_message)
}

fn valid_delivery_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 1024
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
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

pub fn valid_server(value: &str) -> bool {
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

fn valid_server_reference(value: &str) -> bool {
    let value = value.trim();
    let (scheme, server) = if let Some(server) = value.strip_prefix("http://") {
        ("http", server)
    } else if let Some(server) = value.strip_prefix("https://") {
        ("https", server)
    } else {
        ("", value)
    };
    !server.contains('/')
        && !server.contains('?')
        && !server.contains('#')
        && valid_server(server)
        && (scheme.is_empty() || matches!(scheme, "http" | "https"))
}

fn valid_display_text(value: &str, max_len: usize) -> bool {
    !value.is_empty() && value.len() <= max_len && !value.chars().any(char::is_control)
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

    fn encrypted_message() -> EncryptedMessage {
        EncryptedMessage {
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
    fn accepts_complete_current_encrypted_message() {
        assert!(is_supported_message(&encrypted_message()));
    }

    #[test]
    fn rejects_plaintext_only_delivery() {
        let mut value = encrypted_message();
        value.ciphertext.clear();
        assert!(!is_supported_message(&value));
    }

    #[test]
    fn rejects_malformed_or_oversized_encrypted_message_fields() {
        let mut value = encrypted_message();
        value.sender = "alice@example.test/path".to_owned();
        assert!(!is_supported_message(&value));

        let mut value = encrypted_message();
        value.message_id = "x".repeat(129);
        assert!(!is_supported_message(&value));

        let mut value = encrypted_message();
        value.ciphertext = "!".to_owned();
        assert!(!is_supported_message(&value));
    }

    #[test]
    fn discovery_advertises_federation_delivery() {
        let document = discovery(
            "https://example.test".to_owned(),
            "server-1".to_owned(),
            "Enter".to_owned(),
            None,
            true,
        );
        assert!(document.capabilities.contains(&"federation"));
        let value = serde_json::to_value(document).expect("serialize discovery");
        assert_eq!(
            value["endpoints"]["federationDelivery"],
            "/enter/v1/federation/deliveries"
        );

        let disabled = discovery(
            "https://example.test".to_owned(),
            "server-1".to_owned(),
            "Enter".to_owned(),
            None,
            false,
        );
        assert!(!disabled.capabilities.contains(&"federation"));
        let disabled = serde_json::to_value(disabled).expect("serialize disabled discovery");
        assert!(disabled["endpoints"].get("federationDelivery").is_none());
    }

    #[test]
    fn federation_delivery_contains_a_message_with_an_encrypted_message() {
        let encrypted_message = encrypted_message();
        let delivery = FederationDelivery {
            protocol: PROTOCOL_VERSION.to_owned(),
            delivery_id: "message-1:key-1".to_owned(),
            sender_server: "https://example.test".to_owned(),
            sender_name: "Alice".to_owned(),
            sender_avatar: "alice".to_owned(),
            message: FederationMessage {
                id: encrypted_message.message_id.clone(),
                conversation_id: encrypted_message.conversation_id.clone(),
                created_at: 1,
                encrypted_message,
            },
        };
        assert!(is_supported_delivery(&delivery));
        let value = serde_json::to_value(&delivery).expect("serialize delivery");
        assert!(value["message"]["encryptedMessage"].is_object());
        assert!(value.get("encryptedMessage").is_none());

        let mut long_delivery = delivery;
        long_delivery.delivery_id = format!(
            "{}:{}:{}",
            "a".repeat(255),
            "m".repeat(128),
            "k".repeat(128)
        );
        assert!(is_supported_delivery(&long_delivery));
    }
}
