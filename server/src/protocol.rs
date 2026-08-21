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
    pub federation_delivery: &'static str,
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

#[derive(Debug, Deserialize, Serialize)]
pub struct FederationDelivery {
    pub delivery_id: String,
    pub sender_server: String,
    pub envelope: EncryptedEnvelope,
    pub server_signature: String,
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
            "federation",
            "encrypted-messages",
            "encrypted-media",
            "realtime",
        ],
        endpoints: DiscoveryEndpoints {
            keys: "/enter/v1/keys/{handle}",
            federation_delivery: "/enter/v1/federation/deliveries",
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
        && !envelope.message_id.is_empty()
        && !envelope.conversation_id.is_empty()
        && !envelope.sender.is_empty()
        && !envelope.recipient.is_empty()
        && !envelope.sender_device.is_empty()
        && !envelope.key_id.is_empty()
        && !envelope.created_at.is_empty()
        && !envelope.nonce.is_empty()
        && !envelope.ephemeral_public_key.is_empty()
        && !envelope.associated_data.is_empty()
        && !envelope.ciphertext.is_empty()
        && !envelope.signature.is_empty()
}

pub fn is_supported_delivery(delivery: &FederationDelivery) -> bool {
    !delivery.delivery_id.is_empty()
        && !delivery.sender_server.is_empty()
        && !delivery.server_signature.is_empty()
        && is_supported_envelope(&delivery.envelope)
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
    fn rejects_unsigned_or_unidentified_delivery() {
        let delivery = FederationDelivery {
            delivery_id: String::new(),
            sender_server: "https://remote.example".to_owned(),
            envelope: envelope(),
            server_signature: String::new(),
        };
        assert!(!is_supported_delivery(&delivery));
    }
}
