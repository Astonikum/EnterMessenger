use argon2::{
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use axum::{
    body::{Body, Bytes},
    extract::{
        ws::{CloseFrame, Message as WsMessage, WebSocket, WebSocketUpgrade},
        DefaultBodyLimit, Path, Query, State,
    },
    http::{header, HeaderMap, HeaderValue, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
    Json, Router,
};
use rand_core::OsRng;
use serde::{Deserialize, Serialize};
use std::{
    borrow::Cow,
    collections::HashMap,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
};
use tokio::{
    sync::{broadcast, RwLock},
    time::{timeout, Duration},
};
use tower_http::cors::CorsLayer;
use uuid::Uuid;

mod config;
mod protocol;
mod storage;

#[derive(Clone)]
struct AppState {
    db: storage::Storage,
    config: config::ServerConfig,
    server_id: String,
    realtime: RealtimeHub,
}

#[derive(Clone, Default)]
struct RealtimeHub {
    channels: Arc<RwLock<HashMap<String, broadcast::Sender<RealtimeEvent>>>>,
    presence_sessions: Arc<RwLock<HashMap<String, usize>>>,
    metrics: Arc<RealtimeMetrics>,
}

impl RealtimeHub {
    async fn subscribe(&self, account_id: &str) -> broadcast::Receiver<RealtimeEvent> {
        let mut channels = self.channels.write().await;
        channels
            .entry(account_id.to_owned())
            .or_insert_with(|| broadcast::channel(256).0)
            .subscribe()
    }

    async fn publish(&self, account_id: &str, event: RealtimeEvent) {
        let channels = self.channels.read().await;
        if let Some(channel) = channels.get(account_id) {
            let _ = channel.send(event);
        }
    }

    async fn unsubscribe(&self, account_id: &str) {
        let mut channels = self.channels.write().await;
        if channels
            .get(account_id)
            .is_some_and(|channel| channel.receiver_count() == 0)
        {
            channels.remove(account_id);
        }
    }

    async fn try_connect(&self, account_id: &str) -> Result<bool, ()> {
        let mut sessions = self.presence_sessions.write().await;
        let active = self.metrics.active_connections.load(Ordering::Relaxed);
        let account_count = sessions.get(account_id).copied().unwrap_or(0);
        if active >= REALTIME_MAX_CONNECTIONS
            || account_count >= REALTIME_MAX_CONNECTIONS_PER_ACCOUNT
        {
            self.metrics
                .rejected_connections
                .fetch_add(1, Ordering::Relaxed);
            return Err(());
        }
        let count = sessions.entry(account_id.to_owned()).or_insert(0);
        *count += 1;
        self.metrics
            .active_connections
            .fetch_add(1, Ordering::Relaxed);
        self.metrics
            .accepted_connections
            .fetch_add(1, Ordering::Relaxed);
        Ok(*count == 1)
    }

    async fn presence_disconnected(&self, account_id: &str) -> bool {
        let mut sessions = self.presence_sessions.write().await;
        let Some(count) = sessions.get_mut(account_id) else {
            return false;
        };
        self.metrics
            .active_connections
            .fetch_sub(1, Ordering::Relaxed);
        self.metrics
            .closed_connections
            .fetch_add(1, Ordering::Relaxed);
        if *count > 1 {
            *count -= 1;
            return false;
        }
        sessions.remove(account_id);
        true
    }

    fn metrics(&self) -> RealtimeMetricsResponse {
        RealtimeMetricsResponse {
            active_connections: self.metrics.active_connections.load(Ordering::Relaxed),
            accepted_connections: self.metrics.accepted_connections.load(Ordering::Relaxed),
            rejected_connections: self.metrics.rejected_connections.load(Ordering::Relaxed),
            closed_connections: self.metrics.closed_connections.load(Ordering::Relaxed),
            lagged_snapshots: self.metrics.lagged_snapshots.load(Ordering::Relaxed),
        }
    }
}

#[derive(Serialize)]
struct Health {
    service: &'static str,
    status: &'static str,
    protocol: &'static str,
    #[serde(rename = "serverName")]
    server_name: String,
    #[serde(rename = "serverId")]
    server_id: String,
    logo: Option<String>,
    realtime: RealtimeMetricsResponse,
}

#[derive(Serialize)]
struct ProtocolErrorResponse {
    error: &'static str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthRequest {
    name: Option<String>,
    handle: String,
    password: String,
    device_id: Option<String>,
    platform: Option<String>,
    device_name: Option<String>,
    app_version: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
struct AccountSettingsPatch {
    name: Option<String>,
    show_online: Option<bool>,
    show_last_seen: Option<bool>,
    read_receipts: Option<bool>,
    typing_indicators: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
struct ChangePasswordRequest {
    current_password: String,
    new_password: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AccountSettingsResponse {
    id: String,
    name: String,
    handle: String,
    show_online: bool,
    show_last_seen: bool,
    read_receipts: bool,
    typing_indicators: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceResponse {
    device_id: String,
    platform: String,
    name: Option<String>,
    app_version: Option<String>,
    created_at: i64,
    last_seen_at: Option<i64>,
    current: bool,
    revoked_at: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionResponse {
    id: String,
    device_id: Option<String>,
    platform: String,
    device_name: Option<String>,
    app_version: Option<String>,
    created_at: i64,
    expires_at: i64,
    last_seen_at: Option<i64>,
    current: bool,
}

#[derive(Serialize)]
struct AuthProfile {
    id: String,
    name: String,
    handle: String,
    #[serde(rename = "serverId")]
    server_id: String,
}

#[derive(Serialize)]
struct AuthResponse {
    token: String,
    profile: AuthProfile,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConversationResponse {
    id: String,
    #[serde(rename = "serverId")]
    server_id: String,
    name: String,
    handle: Option<String>,
    avatar: String,
    subtitle: Option<String>,
    can_write: bool,
    last_message: String,
    last_message_at: Option<i64>,
    pinned: bool,
    online: bool,
    last_seen_at: Option<i64>,
    unread: i64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MessageResponse {
    id: String,
    conversation_id: String,
    author: String,
    created_at: i64,
    stack_id: String,
    envelope: protocol::EncryptedEnvelope,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncResponse {
    next_cursor: i64,
    conversations: Vec<ConversationResponse>,
    messages: Vec<MessageResponse>,
    read_receipts: Vec<ReadReceiptResponse>,
    delivery_receipts: Vec<DeliveryReceiptResponse>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReadReceiptResponse {
    message_id: String,
    read_at: i64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeliveryReceiptResponse {
    message_id: String,
    delivered_at: i64,
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum RealtimeEvent {
    Message {
        cursor: i64,
        message: MessageResponse,
    },
    ReadReceipt {
        cursor: i64,
        #[serde(rename = "messageId")]
        message_id: String,
        #[serde(rename = "readAt")]
        read_at: i64,
    },
    DeliveryReceipt {
        cursor: i64,
        #[serde(rename = "messageId")]
        message_id: String,
        #[serde(rename = "deliveredAt")]
        delivered_at: i64,
    },
    Presence {
        #[serde(rename = "conversationId")]
        conversation_id: String,
        online: bool,
        #[serde(rename = "lastSeenAt")]
        last_seen_at: i64,
    },
}

#[derive(Deserialize)]
struct RealtimeHello {
    #[serde(rename = "type")]
    kind: String,
    version: u8,
    token: String,
    since: Option<i64>,
}

#[derive(Deserialize)]
struct RealtimeClientMessage {
    #[serde(rename = "type")]
    kind: String,
    since: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MarkReadResponse {
    read_at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DeliveryAckResponse {
    delivered_at: i64,
}

#[derive(Deserialize)]
struct SyncQuery {
    since: Option<i64>,
}

#[derive(Deserialize, Default)]
struct SearchQuery {
    q: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SendMessageRequest {
    conversation_id: String,
    client_message_id: String,
    envelope: Option<protocol::EncryptedEnvelope>,
    #[serde(default)]
    envelopes: Vec<protocol::EncryptedEnvelope>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SendMessageResponse {
    next_cursor: i64,
    message: MessageResponse,
}

#[derive(Deserialize)]
struct FederationDeliveryAck {
    accepted: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MediaUploadResponse {
    accepted: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeviceHistoryEntry {
    conversation_id: String,
    message_id: String,
    source_key_id: Option<String>,
    envelope: protocol::EncryptedEnvelope,
}

#[derive(Deserialize)]
struct DeviceHistoryRequest {
    entries: Vec<DeviceHistoryEntry>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceHistoryResponse {
    accepted: usize,
    next_cursor: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegisterDeviceKeyRequest {
    device_id: String,
    key_id: String,
    encryption_public_key: String,
    signing_public_key: String,
    created_at: i64,
    account_key_id: Option<String>,
    account_encryption_public_key: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegisterPushTokenRequest {
    token: String,
    device_id: String,
    platform: String,
}

#[derive(Serialize)]
struct PushTokenResponse {
    accepted: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateConversationRequest {
    peer_address: String,
    name: String,
    avatar: String,
    subtitle: Option<String>,
}

#[derive(Serialize)]
struct ErrorResponse {
    error: &'static str,
}

const PRESENCE_TIMEOUT_MS: i64 = 30_000;
const REALTIME_PROTOCOL_VERSION: u8 = 1;
const REALTIME_MAX_FRAME_BYTES: usize = 64 * 1024;
const REALTIME_MAX_CONNECTIONS: usize = 256;
const REALTIME_MAX_CONNECTIONS_PER_ACCOUNT: usize = 4;
const REALTIME_HELLO_TIMEOUT: Duration = Duration::from_secs(10);
const REALTIME_SEND_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_JSON_BODY_BYTES: usize = 4 * 1024 * 1024;
const MAX_ENVELOPES_PER_MESSAGE: usize = 64;
const MAX_ENVELOPE_BATCH_BYTES: usize = 3 * 1024 * 1024;
const MAX_LOGO_BYTES: u64 = 4 * 1024 * 1024;
const MAX_PASSWORD_BYTES: usize = 256;
const FEDERATION_REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Default)]
struct RealtimeMetrics {
    active_connections: AtomicUsize,
    accepted_connections: AtomicUsize,
    rejected_connections: AtomicUsize,
    closed_connections: AtomicUsize,
    lagged_snapshots: AtomicUsize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RealtimeMetricsResponse {
    active_connections: usize,
    accepted_connections: usize,
    rejected_connections: usize,
    closed_connections: usize,
    lagged_snapshots: usize,
}

async fn health(State(state): State<AppState>) -> Json<Health> {
    Json(Health {
        service: "enter-server",
        status: "ok",
        protocol: protocol::PROTOCOL_VERSION,
        server_name: state.config.name.clone(),
        server_id: state.server_id.clone(),
        logo: state.config.logo(),
        realtime: state.realtime.metrics(),
    })
}

async fn protocol_discovery(State(state): State<AppState>) -> Json<protocol::DiscoveryDocument> {
    Json(protocol::discovery(
        state.config.public_url.clone(),
        state.server_id.clone(),
        state.config.name.clone(),
        state.config.logo(),
        state.config.federation_secret.is_some(),
    ))
}

async fn server_logo(
    State(state): State<AppState>,
) -> Result<Response, (StatusCode, Json<ProtocolErrorResponse>)> {
    let Some(path) = state.config.logo_path else {
        return Err((
            StatusCode::NOT_FOUND,
            Json(ProtocolErrorResponse {
                error: "logo_not_configured",
            }),
        ));
    };
    let metadata = tokio::fs::metadata(&path).await.map_err(|_| {
        (
            StatusCode::NOT_FOUND,
            Json(ProtocolErrorResponse {
                error: "logo_not_found",
            }),
        )
    })?;
    if !metadata.is_file() || metadata.len() > MAX_LOGO_BYTES {
        return Err((
            StatusCode::PAYLOAD_TOO_LARGE,
            Json(ProtocolErrorResponse {
                error: "logo_too_large",
            }),
        ));
    }
    let bytes = tokio::fs::read(&path).await.map_err(|_| {
        (
            StatusCode::NOT_FOUND,
            Json(ProtocolErrorResponse {
                error: "logo_not_found",
            }),
        )
    })?;
    let content_type = match path.extension().and_then(|value| value.to_str()) {
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        _ => "image/png",
    };
    let mut response = Response::new(bytes.into());
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    Ok(response)
}

fn error(status: StatusCode, message: &'static str) -> (StatusCode, Json<ErrorResponse>) {
    (status, Json(ErrorResponse { error: message }))
}

fn enter_address_parts(address: &str) -> Option<(&str, &str)> {
    let address = address.trim();
    let (handle, server) = address.rsplit_once('@')?;
    protocol::valid_address(address).then_some((handle, server))
}

fn valid_display_text(value: &str, max_len: usize) -> bool {
    !value.is_empty() && value.len() <= max_len && !value.chars().any(char::is_control)
}

fn valid_password(value: &str) -> bool {
    value.len() >= 8 && value.len() <= MAX_PASSWORD_BYTES && !value.chars().any(char::is_control)
}

fn valid_optional_metadata(value: Option<&String>, max_len: usize) -> bool {
    value.map_or(true, |value| valid_display_text(value.trim(), max_len))
}

fn valid_auth_metadata(request: &AuthRequest) -> bool {
    request
        .device_id
        .as_ref()
        .map_or(true, |value| protocol::valid_identifier(value.trim()))
        && valid_optional_metadata(request.platform.as_ref(), 32)
        && valid_optional_metadata(request.device_name.as_ref(), 128)
        && valid_optional_metadata(request.app_version.as_ref(), 64)
}

fn valid_key_material(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 16_384
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'=' | b'-' | b'_')
        })
}

fn valid_envelope_batch(envelopes: &[protocol::EncryptedEnvelope]) -> bool {
    envelopes.len() <= MAX_ENVELOPES_PER_MESSAGE
        && envelopes
            .iter()
            .try_fold(0usize, |size, envelope| {
                serde_json::to_vec(envelope)
                    .ok()
                    .and_then(|value| size.checked_add(value.len()))
            })
            .is_some_and(|size| size <= MAX_ENVELOPE_BATCH_BYTES)
}

fn envelope_belongs_to_account(
    envelope: &protocol::EncryptedEnvelope,
    account: &storage::StoredAccount,
    public_url: &str,
) -> bool {
    enter_address_parts(&envelope.sender)
        .is_some_and(|(handle, server)| handle == account.handle && same_server(public_url, server))
}

fn normalize_server(value: &str) -> String {
    let value = value.trim().trim_end_matches('/').to_ascii_lowercase();
    let value = value
        .strip_prefix("http://")
        .or_else(|| value.strip_prefix("https://"))
        .unwrap_or(&value);
    let (host, suffix): (&str, String) = if let Some(rest) = value.strip_prefix('[') {
        rest.split_once(']')
            .map(|(host, suffix)| (host, suffix.to_owned()))
            .unwrap_or((value, String::new()))
    } else {
        value
            .split_once(':')
            .map(|(host, suffix)| (host, format!(":{suffix}")))
            .unwrap_or((value, String::new()))
    };
    let host = match host {
        "localhost" | "127.0.0.1" | "0.0.0.0" | "::1" => "127.0.0.1",
        _ => host,
    };
    format!("{host}{suffix}")
}

fn same_server(local_url: &str, remote_server: &str) -> bool {
    normalize_server(local_url) == normalize_server(remote_server)
}

fn canonical_address(server_url: &str, handle: &str) -> String {
    let server = server_url.trim().trim_end_matches('/');
    let server = server
        .strip_prefix("http://")
        .or_else(|| server.strip_prefix("https://"))
        .unwrap_or(server);
    format!("{handle}@{server}")
}

fn constant_time_equal(left: &str, right: &str) -> bool {
    let mut difference = left.len() ^ right.len();
    for (left, right) in left.bytes().zip(right.bytes()) {
        difference |= usize::from(left ^ right);
    }
    difference == 0
}

fn federation_authorized(headers: &HeaderMap, expected_secret: Option<&str>) -> bool {
    let Some(expected_secret) = expected_secret.filter(|value| !value.is_empty()) else {
        return false;
    };
    let Some(token) = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
    else {
        return false;
    };
    constant_time_equal(token.trim(), expected_secret)
}

fn federation_urls(remote_server: &str, allow_http: bool) -> Vec<String> {
    let server = normalize_server(remote_server);
    let mut schemes = vec!["https"];
    if allow_http {
        schemes.push("http");
    }
    schemes
        .into_iter()
        .map(|scheme| format!("{scheme}://{server}/enter/v1/federation/deliveries"))
        .collect()
}

fn federation_delivery_error(
    delivery: &protocol::FederationDelivery,
    local_server: &str,
) -> Option<&'static str> {
    if !protocol::is_supported_delivery(delivery) {
        return Some("invalid_federation_delivery");
    }
    let envelope = &delivery.message.envelope;
    let Some((_, envelope_sender_server)) = enter_address_parts(&envelope.sender) else {
        return Some("invalid_federation_delivery");
    };
    if !same_server(&delivery.sender_server, envelope_sender_server) {
        return Some("sender_server_mismatch");
    }
    if same_server(local_server, envelope_sender_server) {
        return Some("federation_loop");
    }
    let Some((_, recipient_server)) = enter_address_parts(&envelope.recipient) else {
        return Some("invalid_federation_delivery");
    };
    if !same_server(local_server, recipient_server) {
        return Some("wrong_recipient_server");
    }
    None
}

async fn forward_federation_message(
    state: &AppState,
    sender: &storage::StoredAccount,
    envelope: &protocol::EncryptedEnvelope,
    created_at: i64,
) -> Result<(), (StatusCode, Json<ErrorResponse>)> {
    let Some(secret) = state.config.federation_secret.as_deref() else {
        return Err(error(StatusCode::BAD_REQUEST, "federation_not_configured"));
    };
    let Some((_, recipient_server)) = enter_address_parts(&envelope.recipient) else {
        return Err(error(StatusCode::BAD_REQUEST, "invalid_message"));
    };
    let delivery = protocol::FederationDelivery {
        protocol: protocol::PROTOCOL_VERSION.to_owned(),
        delivery_id: format!(
            "{}:{}:{}",
            normalize_server(&state.config.public_url),
            envelope.message_id,
            envelope.key_id
        ),
        sender_server: state.config.public_url.clone(),
        sender_name: sender.name.clone(),
        sender_avatar: sender.handle.clone(),
        message: protocol::FederationMessage {
            id: envelope.message_id.clone(),
            conversation_id: envelope.conversation_id.clone(),
            created_at,
            envelope: envelope.clone(),
        },
    };
    let client = reqwest::Client::builder()
        .timeout(FEDERATION_REQUEST_TIMEOUT)
        .build()
        .map_err(|_| error(StatusCode::BAD_GATEWAY, "federation_delivery_failed"))?;
    for url in federation_urls(recipient_server, state.config.federation_allow_http) {
        let response = match client
            .post(&url)
            .bearer_auth(secret)
            .json(&delivery)
            .send()
            .await
        {
            Ok(response) => response,
            Err(_) => continue,
        };
        if !response.status().is_success() {
            continue;
        }
        let accepted = response
            .json::<FederationDeliveryAck>()
            .await
            .ok()
            .is_some_and(|response| response.accepted);
        if accepted {
            return Ok(());
        }
    }
    Err(error(StatusCode::BAD_GATEWAY, "federation_delivery_failed"))
}

async fn deliver_local_message(
    state: &AppState,
    sender: &storage::StoredAccount,
    envelope: &protocol::EncryptedEnvelope,
    envelope_json: &str,
    created_at: i64,
    notify: bool,
) -> Result<(), (StatusCode, Json<ErrorResponse>)> {
    let Some((recipient_handle, recipient_server)) = enter_address_parts(&envelope.recipient)
    else {
        return Ok(());
    };
    if !same_server(&state.config.public_url, recipient_server) {
        return Ok(());
    }

    let Some(recipient) = state
        .db
        .account_by_handle(recipient_handle)
        .await
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"))?
    else {
        return Ok(());
    };
    if recipient.id == sender.id {
        return Ok(());
    }

    let sender_address = canonical_address(&state.config.public_url, &sender.handle);
    let delivery_id = format!("{}:{}", envelope.message_id, envelope.key_id);
    let delivered = state
        .db
        .deliver_message(
            &recipient.id,
            &envelope.conversation_id,
            &sender_address,
            &sender.name,
            &sender.handle,
            &delivery_id,
            envelope_json,
            created_at,
        )
        .await
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"))?;
    if let Some(message) = delivered {
        if let Some(event) = state
            .db
            .event_for_message(&recipient.id, &message.id)
            .await
            .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"))?
        {
            publish_stored_event(state, event).await;
        }
        if notify {
            tokio::spawn(send_push_notification(
                state.clone(),
                recipient.id.clone(),
                sender.name.clone(),
                envelope.conversation_id.clone(),
                message.id.clone(),
            ));
        }
    }
    Ok(())
}

async fn federation_delivery(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(delivery): Json<protocol::FederationDelivery>,
) -> Result<Json<protocol::FederationDeliveryResponse>, (StatusCode, Json<ErrorResponse>)> {
    let Some(secret) = state.config.federation_secret.as_deref() else {
        return Err(error(
            StatusCode::SERVICE_UNAVAILABLE,
            "federation_not_configured",
        ));
    };
    if !federation_authorized(&headers, Some(secret)) {
        return Err(error(StatusCode::UNAUTHORIZED, "federation_unauthorized"));
    }
    if let Some(reason) = federation_delivery_error(&delivery, &state.config.public_url) {
        return Err(error(StatusCode::BAD_REQUEST, reason));
    }
    let envelope = &delivery.message.envelope;
    let Some((recipient_handle, _)) = enter_address_parts(&envelope.recipient) else {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "invalid_federation_delivery",
        ));
    };
    let Some(recipient) = state
        .db
        .account_by_handle(recipient_handle)
        .await
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"))?
    else {
        return Err(error(StatusCode::NOT_FOUND, "recipient_not_found"));
    };
    let envelope_json = serde_json::to_string(envelope)
        .map_err(|_| error(StatusCode::BAD_REQUEST, "invalid_federation_delivery"))?;
    let delivered = state
        .db
        .deliver_message(
            &recipient.id,
            &envelope.conversation_id,
            &envelope.sender,
            &delivery.sender_name,
            &delivery.sender_avatar,
            &delivery.delivery_id,
            &envelope_json,
            storage::now_ms(),
        )
        .await
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"))?;
    if let Some(message) = delivered {
        if let Some(event) = state
            .db
            .event_for_message(&recipient.id, &message.id)
            .await
            .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"))?
        {
            publish_stored_event(&state, event).await;
        }
        tokio::spawn(send_push_notification(
            state.clone(),
            recipient.id.clone(),
            delivery.sender_name.clone(),
            envelope.conversation_id.clone(),
            message.id,
        ));
    }
    Ok(Json(protocol::FederationDeliveryResponse {
        protocol: protocol::PROTOCOL_VERSION,
        delivery_id: delivery.delivery_id,
        accepted: true,
    }))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExpoPushMessage {
    to: String,
    title: String,
    body: String,
    data: serde_json::Value,
    channel_id: String,
}

async fn send_push_notification(
    state: AppState,
    account_id: String,
    title: String,
    conversation_id: String,
    message_id: String,
) {
    let Ok(tokens) = state.db.push_tokens(&account_id).await else {
        return;
    };
    if tokens.is_empty() {
        return;
    }
    let payload = tokens
        .into_iter()
        .map(|token| ExpoPushMessage {
            to: token,
            title: title.clone(),
            body: "Новое сообщение".to_owned(),
            data: serde_json::json!({
                "profileId": account_id,
                "conversationId": conversation_id,
                "messageId": message_id,
            }),
            channel_id: "messages".to_owned(),
        })
        .collect::<Vec<_>>();
    match reqwest::Client::new()
        .post(&state.config.expo_push_url)
        .json(&payload)
        .send()
        .await
    {
        Ok(response) if !response.status().is_success() => {
            eprintln!("push provider returned {}", response.status());
        }
        Err(error) => eprintln!("push delivery failed: {error}"),
        _ => {}
    }
}

fn auth_response(account: &storage::StoredAccount, server_id: &str) -> AuthResponse {
    AuthResponse {
        token: Uuid::new_v4().to_string(),
        profile: AuthProfile {
            id: account.id.clone(),
            name: account.name.clone(),
            handle: account.handle.clone(),
            server_id: server_id.to_owned(),
        },
    }
}

async fn register(
    State(state): State<AppState>,
    Json(request): Json<AuthRequest>,
) -> Result<Json<AuthResponse>, (StatusCode, Json<ErrorResponse>)> {
    let name = request
        .name
        .as_deref()
        .unwrap_or_default()
        .trim()
        .to_owned();
    let handle = request.handle.trim().trim_start_matches('@').to_lowercase();
    if !valid_display_text(&name, 160)
        || !protocol::valid_handle(&handle)
        || !valid_password(&request.password)
        || !valid_auth_metadata(&request)
    {
        return Err(error(StatusCode::BAD_REQUEST, "invalid_registration"));
    }

    let salt = SaltString::generate(&mut OsRng);
    let password_hash = Argon2::default()
        .hash_password(request.password.as_bytes(), &salt)
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "password_hash_failed"))?
        .to_string();
    let account = storage::StoredAccount {
        id: Uuid::new_v4().to_string(),
        name,
        handle: handle.clone(),
        password_hash,
    };

    let response = auth_response(&account, &state.server_id);
    let inserted = state
        .db
        .create_account(&account, storage::now_ms())
        .await
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"))?;
    if !inserted {
        return Err(error(StatusCode::CONFLICT, "handle_taken"));
    }
    state
        .db
        .store_session_with_metadata(
            &response.token,
            &account.id,
            storage::now_ms(),
            request.device_id.as_deref(),
            request.platform.as_deref(),
            request.device_name.as_deref(),
            request.app_version.as_deref(),
        )
        .await
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"))?;
    if let Some(device_id) = request.device_id.as_deref() {
        state
            .db
            .upsert_device(
                &account.id,
                device_id.trim(),
                request.platform.as_deref().unwrap_or("unknown"),
                request.device_name.as_deref(),
                request.app_version.as_deref(),
                storage::now_ms(),
            )
            .await
            .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"))?;
    }
    Ok(Json(response))
}

async fn login(
    State(state): State<AppState>,
    Json(request): Json<AuthRequest>,
) -> Result<Json<AuthResponse>, (StatusCode, Json<ErrorResponse>)> {
    let handle = request.handle.trim().trim_start_matches('@').to_lowercase();
    if !protocol::valid_handle(&handle)
        || !valid_password(&request.password)
        || !valid_auth_metadata(&request)
    {
        return Err(error(StatusCode::UNAUTHORIZED, "invalid_credentials"));
    }
    let Some(account) = state
        .db
        .account_by_handle(&handle)
        .await
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"))?
    else {
        return Err(error(StatusCode::UNAUTHORIZED, "invalid_credentials"));
    };
    let parsed_hash = PasswordHash::new(&account.password_hash)
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "password_hash_failed"))?;
    if Argon2::default()
        .verify_password(request.password.as_bytes(), &parsed_hash)
        .is_err()
    {
        return Err(error(StatusCode::UNAUTHORIZED, "invalid_credentials"));
    }
    let response = auth_response(&account, &state.server_id);
    state
        .db
        .store_session_with_metadata(
            &response.token,
            &response.profile.id,
            storage::now_ms(),
            request.device_id.as_deref(),
            request.platform.as_deref(),
            request.device_name.as_deref(),
            request.app_version.as_deref(),
        )
        .await
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"))?;
    if let Some(device_id) = request.device_id.as_deref() {
        state
            .db
            .upsert_device(
                &response.profile.id,
                device_id.trim(),
                request.platform.as_deref().unwrap_or("unknown"),
                request.device_name.as_deref(),
                request.app_version.as_deref(),
                storage::now_ms(),
            )
            .await
            .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"))?;
    }
    Ok(Json(response))
}

fn bearer_token(headers: &HeaderMap) -> Result<&str, (StatusCode, Json<ErrorResponse>)> {
    let Some(value) = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
    else {
        return Err(error(StatusCode::UNAUTHORIZED, "unauthorized"));
    };
    let Some(token) = value.strip_prefix("Bearer ").map(str::trim) else {
        return Err(error(StatusCode::UNAUTHORIZED, "unauthorized"));
    };
    if token.is_empty() || token.len() > 128 || token.chars().any(char::is_control) {
        return Err(error(StatusCode::UNAUTHORIZED, "unauthorized"));
    }
    Ok(token)
}

async fn bearer_account_id(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<String, (StatusCode, Json<ErrorResponse>)> {
    let token = bearer_token(headers)?;
    state
        .db
        .account_id_for_session(token, storage::now_ms())
        .await
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"))?
        .ok_or_else(|| error(StatusCode::UNAUTHORIZED, "unauthorized"))
}

async fn logout(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ErrorResponse>)> {
    let token = bearer_token(&headers)?;
    state
        .db
        .revoke_session(token)
        .await
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"))?;
    Ok(Json(serde_json::json!({ "accepted": true })))
}

fn account_settings_response(
    account: storage::StoredAccount,
    settings: storage::AccountSettings,
) -> AccountSettingsResponse {
    AccountSettingsResponse {
        id: account.id,
        name: account.name,
        handle: account.handle,
        show_online: settings.show_online,
        show_last_seen: settings.show_last_seen,
        read_receipts: settings.read_receipts,
        typing_indicators: settings.typing_indicators,
    }
}

async fn get_account_settings(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<AccountSettingsResponse>, (StatusCode, Json<ErrorResponse>)> {
    let account_id = bearer_account_id(&state, &headers).await?;
    let account = state
        .db
        .account_by_id(&account_id)
        .await
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"))?
        .ok_or_else(|| error(StatusCode::UNAUTHORIZED, "unauthorized"))?;
    let settings = state
        .db
        .account_settings(&account_id)
        .await
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"))?;
    Ok(Json(account_settings_response(account, settings)))
}

async fn patch_account_settings(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<AccountSettingsPatch>,
) -> Result<Json<AccountSettingsResponse>, (StatusCode, Json<ErrorResponse>)> {
    let account_id = bearer_account_id(&state, &headers).await?;
    let mut settings = state
        .db
        .account_settings(&account_id)
        .await
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"))?;
    if let Some(value) = request.show_online {
        settings.show_online = value;
    }
    if let Some(value) = request.show_last_seen {
        settings.show_last_seen = value;
    }
    if let Some(value) = request.read_receipts {
        settings.read_receipts = value;
    }
    if let Some(value) = request.typing_indicators {
        settings.typing_indicators = value;
    }
    if let Some(name) = request.name {
        let name = name.trim();
        if !valid_display_text(name, 160) {
            return Err(error(StatusCode::BAD_REQUEST, "invalid_name"));
        }
        if !state
            .db
            .update_account_name(&account_id, name)
            .await
            .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"))?
        {
            return Err(error(StatusCode::UNAUTHORIZED, "unauthorized"));
        }
    }
    state
        .db
        .update_account_settings(&account_id, &settings, storage::now_ms())
        .await
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"))?;
    let account = state
        .db
        .account_by_id(&account_id)
        .await
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"))?
        .ok_or_else(|| error(StatusCode::UNAUTHORIZED, "unauthorized"))?;
    Ok(Json(account_settings_response(account, settings)))
}

async fn change_password(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<ChangePasswordRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ErrorResponse>)> {
    let account_id = bearer_account_id(&state, &headers).await?;
    if !valid_password(&request.current_password) || !valid_password(&request.new_password) {
        return Err(error(StatusCode::BAD_REQUEST, "invalid_password"));
    }
    let account = state
        .db
        .account_by_id(&account_id)
        .await
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"))?
        .ok_or_else(|| error(StatusCode::UNAUTHORIZED, "unauthorized"))?;
    let parsed_hash = PasswordHash::new(&account.password_hash)
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "password_hash_failed"))?;
    if Argon2::default()
        .verify_password(request.current_password.as_bytes(), &parsed_hash)
        .is_err()
    {
        return Err(error(StatusCode::UNAUTHORIZED, "invalid_credentials"));
    }
    let salt = SaltString::generate(&mut OsRng);
    let password_hash = Argon2::default()
        .hash_password(request.new_password.as_bytes(), &salt)
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "password_hash_failed"))?
        .to_string();
    if !state
        .db
        .change_password(&account_id, &password_hash)
        .await
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"))?
    {
        return Err(error(StatusCode::UNAUTHORIZED, "unauthorized"));
    }
    Ok(Json(serde_json::json!({ "accepted": true })))
}

async fn list_sessions(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<SessionResponse>>, (StatusCode, Json<ErrorResponse>)> {
    let token = bearer_token(&headers)?.to_owned();
    let account_id = state
        .db
        .account_id_for_session(&token, storage::now_ms())
        .await
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"))?
        .ok_or_else(|| error(StatusCode::UNAUTHORIZED, "unauthorized"))?;
    let sessions = state
        .db
        .list_sessions(&account_id, &token, storage::now_ms())
        .await
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"))?;
    Ok(Json(
        sessions
            .into_iter()
            .map(|session| SessionResponse {
                id: session.id,
                device_id: session.device_id,
                platform: session.platform,
                device_name: session.device_name,
                app_version: session.app_version,
                created_at: session.created_at,
                expires_at: session.expires_at,
                last_seen_at: session.last_seen_at,
                current: session.current,
            })
            .collect(),
    ))
}

async fn revoke_session(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ErrorResponse>)> {
    let token = bearer_token(&headers)?.to_owned();
    let account_id = state
        .db
        .account_id_for_session(&token, storage::now_ms())
        .await
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"))?
        .ok_or_else(|| error(StatusCode::UNAUTHORIZED, "unauthorized"))?;
    if !protocol::valid_identifier(&session_id) {
        return Err(error(StatusCode::BAD_REQUEST, "invalid_session"));
    }
    let sessions = state
        .db
        .list_sessions(&account_id, &token, storage::now_ms())
        .await
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"))?;
    if sessions
        .iter()
        .any(|session| session.id == session_id && session.current)
    {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "cannot_revoke_current_session",
        ));
    }
    if !state
        .db
        .revoke_session_by_id(&account_id, &session_id)
        .await
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"))?
    {
        return Err(error(StatusCode::NOT_FOUND, "session_not_found"));
    }
    Ok(Json(serde_json::json!({ "accepted": true })))
}

async fn revoke_other_sessions(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ErrorResponse>)> {
    let token = bearer_token(&headers)?.to_owned();
    let account_id = state
        .db
        .account_id_for_session(&token, storage::now_ms())
        .await
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"))?
        .ok_or_else(|| error(StatusCode::UNAUTHORIZED, "unauthorized"))?;
    let revoked = state
        .db
        .revoke_other_sessions(&account_id, &token)
        .await
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"))?;
    Ok(Json(
        serde_json::json!({ "accepted": true, "revoked": revoked }),
    ))
}

async fn list_devices(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<DeviceResponse>>, (StatusCode, Json<ErrorResponse>)> {
    let token = bearer_token(&headers)?.to_owned();
    let account_id = state
        .db
        .account_id_for_session(&token, storage::now_ms())
        .await
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"))?
        .ok_or_else(|| error(StatusCode::UNAUTHORIZED, "unauthorized"))?;
    let current_device_id = state
        .db
        .list_sessions(&account_id, &token, storage::now_ms())
        .await
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"))?
        .into_iter()
        .find(|session| session.current)
        .and_then(|session| session.device_id);
    let devices = state
        .db
        .list_devices(&account_id)
        .await
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"))?;
    Ok(Json(
        devices
            .into_iter()
            .map(|device| DeviceResponse {
                current: current_device_id.as_deref() == Some(device.device_id.as_str()),
                device_id: device.device_id,
                platform: device.platform,
                name: device.name,
                app_version: device.app_version,
                created_at: device.created_at,
                last_seen_at: device.last_seen_at,
                revoked_at: device.revoked_at,
            })
            .collect(),
    ))
}

async fn revoke_device(
    State(state): State<AppState>,
    Path(device_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ErrorResponse>)> {
    let token = bearer_token(&headers)?.to_owned();
    let account_id = state
        .db
        .account_id_for_session(&token, storage::now_ms())
        .await
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"))?
        .ok_or_else(|| error(StatusCode::UNAUTHORIZED, "unauthorized"))?;
    if !protocol::valid_identifier(&device_id) {
        return Err(error(StatusCode::BAD_REQUEST, "invalid_device"));
    }
    let sessions = state
        .db
        .list_sessions(&account_id, &token, storage::now_ms())
        .await
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"))?;
    if sessions
        .iter()
        .any(|session| session.current && session.device_id.as_deref() == Some(device_id.as_str()))
    {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "cannot_revoke_current_device",
        ));
    }
    if !state
        .db
        .revoke_device(&account_id, &device_id, storage::now_ms())
        .await
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"))?
    {
        return Err(error(StatusCode::NOT_FOUND, "device_not_found"));
    }
    Ok(Json(serde_json::json!({ "accepted": true })))
}

fn conversation_response(
    value: storage::StoredConversation,
    server_id: &str,
    now: i64,
) -> ConversationResponse {
    // `last_seen_at` is populated only when the storage join found a local peer.
    // Do not gate it on public_url: localhost/LAN/proxy aliases are valid ways
    // to reach the same server and must not hide presence.
    let presence_available = value.last_seen_at.is_some();
    let online = value.online
        || value
            .last_seen_at
            .is_some_and(|last_seen| now.saturating_sub(last_seen) <= PRESENCE_TIMEOUT_MS);
    ConversationResponse {
        id: value.id,
        server_id: server_id.to_owned(),
        name: value.name,
        handle: value.handle,
        avatar: value.avatar,
        subtitle: value.subtitle,
        can_write: value.can_write,
        last_message: value.last_message,
        last_message_at: value.last_message_at,
        pinned: value.pinned,
        online,
        last_seen_at: presence_available.then_some(value.last_seen_at).flatten(),
        unread: value.unread,
    }
}

fn message_response(value: storage::StoredMessage) -> Result<MessageResponse, serde_json::Error> {
    Ok(MessageResponse {
        id: value.id,
        conversation_id: value.conversation_id,
        author: value.author,
        created_at: value.created_at,
        stack_id: value.stack_id,
        envelope: serde_json::from_str(&value.envelope_json)?,
    })
}

fn realtime_event(value: storage::StoredEvent) -> Option<RealtimeEvent> {
    match value {
        storage::StoredEvent::Message {
            cursor, message, ..
        } => Some(RealtimeEvent::Message {
            cursor,
            message: message_response(message).ok()?,
        }),
        storage::StoredEvent::ReadReceipt {
            cursor,
            message_id,
            read_at,
            ..
        } => Some(RealtimeEvent::ReadReceipt {
            cursor,
            message_id,
            read_at,
        }),
        storage::StoredEvent::DeliveryReceipt {
            cursor,
            message_id,
            delivered_at,
            ..
        } => Some(RealtimeEvent::DeliveryReceipt {
            cursor,
            message_id,
            delivered_at,
        }),
    }
}

async fn publish_stored_event(state: &AppState, event: storage::StoredEvent) {
    let account_id = event.account_id().to_owned();
    if let Some(event) = realtime_event(event) {
        state.realtime.publish(&account_id, event).await;
    }
}

async fn publish_presence(state: &AppState, account_id: &str, online: bool, last_seen_at: i64) {
    let Ok(watchers) = state
        .db
        .presence_watchers(account_id, &state.config.public_url)
        .await
    else {
        return;
    };
    for watcher in watchers {
        state
            .realtime
            .publish(
                &watcher.owner_account_id,
                RealtimeEvent::Presence {
                    conversation_id: watcher.conversation_id,
                    online,
                    last_seen_at,
                },
            )
            .await;
    }
}

async fn disconnect_presence(state: &AppState, account_id: &str) {
    if !state.realtime.presence_disconnected(account_id).await {
        return;
    }
    let now = storage::now_ms();
    let _ = state.db.touch_presence(account_id, now).await;
    publish_presence(state, account_id, false, now).await;
}

async fn sync_payload(
    state: &AppState,
    account_id: &str,
    since: i64,
) -> Result<SyncResponse, &'static str> {
    let now = storage::now_ms();
    state
        .db
        .touch_presence(account_id, now)
        .await
        .map_err(|_| "storage_failed")?;
    let snapshot = state
        .db
        .sync(account_id, since.max(0), &state.config.public_url)
        .await
        .map_err(|_| "storage_failed")?;
    let messages = snapshot
        .messages
        .into_iter()
        .map(message_response)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "invalid_stored_envelope")?;
    Ok(SyncResponse {
        next_cursor: snapshot.cursor,
        conversations: snapshot
            .conversations
            .into_iter()
            .map(|conversation| conversation_response(conversation, &state.server_id, now))
            .collect(),
        messages,
        read_receipts: snapshot
            .read_receipts
            .into_iter()
            .map(|receipt| ReadReceiptResponse {
                message_id: receipt.message_id,
                read_at: receipt.read_at,
            })
            .collect(),
        delivery_receipts: snapshot
            .delivery_receipts
            .into_iter()
            .map(|receipt| DeliveryReceiptResponse {
                message_id: receipt.message_id,
                delivered_at: receipt.delivered_at,
            })
            .collect(),
    })
}

async fn send_realtime_snapshot(
    socket: &mut WebSocket,
    state: &AppState,
    account_id: &str,
    since: i64,
) -> bool {
    let Ok(snapshot) = sync_payload(state, account_id, since).await else {
        return false;
    };
    let Ok(mut payload) = serde_json::to_value(snapshot) else {
        return false;
    };
    payload["type"] = serde_json::Value::String("sync".to_owned());
    send_realtime_payload(socket, payload.to_string()).await
}

async fn send_realtime_event(socket: &mut WebSocket, event: RealtimeEvent) -> bool {
    let Ok(payload) = serde_json::to_string(&event) else {
        return false;
    };
    send_realtime_payload(socket, payload).await
}

async fn send_realtime_payload(socket: &mut WebSocket, payload: String) -> bool {
    timeout(REALTIME_SEND_TIMEOUT, socket.send(WsMessage::Text(payload)))
        .await
        .is_ok_and(|result| result.is_ok())
}

async fn close_realtime(socket: &mut WebSocket, code: u16, reason: &'static str) {
    let _ = timeout(
        REALTIME_SEND_TIMEOUT,
        socket.send(WsMessage::Close(Some(CloseFrame {
            code,
            reason: Cow::Borrowed(reason),
        }))),
    )
    .await;
}

fn realtime_error_payload(error_code: &'static str) -> String {
    serde_json::json!({ "type": "error", "code": error_code }).to_string()
}

async fn fail_realtime(socket: &mut WebSocket, error_code: &'static str, close_code: u16) {
    if send_realtime_payload(socket, realtime_error_payload(error_code)).await {
        close_realtime(socket, close_code, error_code).await;
    }
}

fn realtime_hello_error(hello: &RealtimeHello) -> Option<&'static str> {
    (hello.kind != "hello"
        || hello.version != REALTIME_PROTOCOL_VERSION
        || hello.token.trim().is_empty())
    .then_some("unsupported_protocol")
}

fn origin(value: &str) -> Option<String> {
    let uri = value.parse::<Uri>().ok()?;
    let scheme = uri.scheme_str()?.to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return None;
    }
    let authority = uri.authority()?.as_str().to_ascii_lowercase();
    (!authority.is_empty() && !authority.contains('@')).then(|| format!("{scheme}://{authority}"))
}

fn parse_request_origin(value: &str) -> Option<String> {
    let uri = value.parse::<Uri>().ok()?;
    if (!uri.path().is_empty() && uri.path() != "/") || uri.query().is_some() {
        return None;
    }
    origin(value)
}

fn is_embedded_app_origin(value: &str) -> bool {
    matches!(
        value,
        "tauri://localhost" | "http://tauri.localhost" | "https://tauri.localhost"
    )
}

fn is_local_dev_origin(value: &str) -> bool {
    let Ok(uri) = value.parse::<Uri>() else {
        return false;
    };
    let Some(scheme) = uri.scheme_str() else {
        return false;
    };
    let Some(host) = uri.host() else {
        return false;
    };
    let Some(port) = uri.port_u16() else {
        return false;
    };
    if scheme != "http" && scheme != "https" || !matches!(port, 8081 | 1420 | 19006) {
        return false;
    }
    let host = host.trim_matches(['[', ']']).to_ascii_lowercase();
    if matches!(host.as_str(), "localhost" | "::1") || host.starts_with("127.") {
        return true;
    }
    let Ok(address) = host.parse::<std::net::Ipv4Addr>() else {
        return false;
    };
    let octets = address.octets();
    octets[0] == 10
        || octets[0] == 192 && octets[1] == 168
        || octets[0] == 172 && (16..=31).contains(&octets[1])
        || octets[0] == 169 && octets[1] == 254
}

fn realtime_origin_allowed(headers: &HeaderMap, public_url: &str) -> bool {
    let Some(request_origin) = headers.get(header::ORIGIN) else {
        // Native clients do not send Origin. Browser clients must send the configured origin.
        return true;
    };
    let Some(request_origin) = request_origin.to_str().ok() else {
        return false;
    };
    if is_embedded_app_origin(request_origin) || is_local_dev_origin(request_origin) {
        return true;
    }
    let Some(request_origin) = parse_request_origin(request_origin) else {
        return false;
    };
    origin(public_url).is_some_and(|expected| expected == request_origin)
}

async fn realtime(
    State(state): State<AppState>,
    headers: HeaderMap,
    websocket: WebSocketUpgrade,
) -> Result<Response, (StatusCode, Json<ErrorResponse>)> {
    if !realtime_origin_allowed(&headers, &state.config.public_url) {
        return Err(error(StatusCode::FORBIDDEN, "origin_not_allowed"));
    }
    Ok(websocket
        .max_frame_size(REALTIME_MAX_FRAME_BYTES)
        .max_message_size(REALTIME_MAX_FRAME_BYTES)
        .on_upgrade(move |socket| realtime_session(socket, state))
        .into_response())
}

async fn realtime_session(mut socket: WebSocket, state: AppState) {
    let hello_text = match timeout(REALTIME_HELLO_TIMEOUT, socket.recv()).await {
        Err(_) => {
            fail_realtime(&mut socket, "hello_timeout", 1002).await;
            return;
        }
        Ok(Some(Ok(WsMessage::Text(text)))) if text.len() <= REALTIME_MAX_FRAME_BYTES => text,
        Ok(Some(Ok(WsMessage::Text(_)))) => {
            fail_realtime(&mut socket, "frame_too_large", 1009).await;
            return;
        }
        Ok(Some(Ok(_))) => {
            fail_realtime(&mut socket, "invalid_hello", 1002).await;
            return;
        }
        Ok(Some(Err(_))) | Ok(None) => return,
    };
    let Ok(hello) = serde_json::from_str::<RealtimeHello>(&hello_text) else {
        fail_realtime(&mut socket, "invalid_hello", 1002).await;
        return;
    };
    if let Some(error_code) = realtime_hello_error(&hello) {
        fail_realtime(&mut socket, error_code, 1002).await;
        return;
    }
    let Ok(Some(account_id)) = state
        .db
        .account_id_for_session(&hello.token, storage::now_ms())
        .await
    else {
        fail_realtime(&mut socket, "unauthorized", 1008).await;
        return;
    };
    let first_presence_session = match state.realtime.try_connect(&account_id).await {
        Ok(first) => first,
        Err(()) => {
            fail_realtime(&mut socket, "too_many_connections", 1013).await;
            return;
        }
    };
    let mut events = state.realtime.subscribe(&account_id).await;
    if !send_realtime_payload(
        &mut socket,
        serde_json::json!({ "type": "ready", "version": REALTIME_PROTOCOL_VERSION }).to_string(),
    )
    .await
    {
        disconnect_presence(&state, &account_id).await;
        return;
    }
    if !send_realtime_snapshot(&mut socket, &state, &account_id, hello.since.unwrap_or(0)).await {
        disconnect_presence(&state, &account_id).await;
        return;
    }
    if first_presence_session {
        publish_presence(&state, &account_id, true, storage::now_ms()).await;
    }

    let mut heartbeat = tokio::time::interval(Duration::from_secs(20));
    loop {
        tokio::select! {
            _ = heartbeat.tick() => {
                if state.db.touch_presence(&account_id, storage::now_ms()).await.is_err() {
                    break;
                }
                if timeout(
                    REALTIME_SEND_TIMEOUT,
                    socket.send(WsMessage::Ping(Vec::new())),
                )
                .await
                .is_err()
                {
                    break;
                }
            }
            incoming = socket.recv() => {
                match incoming {
                    Some(Ok(WsMessage::Text(text))) => {
                        if text.len() > REALTIME_MAX_FRAME_BYTES {
                            fail_realtime(&mut socket, "frame_too_large", 1009).await;
                            break;
                        }
                        let Ok(command) = serde_json::from_str::<RealtimeClientMessage>(&text) else {
                            fail_realtime(&mut socket, "invalid_command", 1002).await;
                            break;
                        };
                        match command.kind.as_str() {
                            "ping" => {
                                if !send_realtime_payload(&mut socket, serde_json::json!({ "type": "pong" }).to_string()).await { break; }
                            }
                            "sync" => {
                                if !send_realtime_snapshot(&mut socket, &state, &account_id, command.since.unwrap_or(0)).await { break; }
                            }
                            _ => {
                                fail_realtime(&mut socket, "unsupported_command", 1002).await;
                                break;
                            }
                        }
                    }
                    Some(Ok(WsMessage::Ping(payload))) => {
                        if !timeout(REALTIME_SEND_TIMEOUT, socket.send(WsMessage::Pong(payload)))
                            .await
                            .is_ok_and(|result| result.is_ok()) { break; }
                    }
                    Some(Ok(WsMessage::Close(_))) | None | Some(Err(_)) => break,
                    Some(Ok(WsMessage::Binary(_))) => {
                        fail_realtime(&mut socket, "unsupported_frame", 1003).await;
                        break;
                    }
                    _ => {}
                }
            }
            event = events.recv() => {
                match event {
                    Ok(event) => {
                        if !send_realtime_event(&mut socket, event).await { break; }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        state.realtime.metrics.lagged_snapshots.fetch_add(1, Ordering::Relaxed);
                        let cursor = state.db.cursor(&account_id).await.unwrap_or(0);
                        if !send_realtime_snapshot(&mut socket, &state, &account_id, cursor.saturating_sub(256)).await { break; }
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        }
    }
    drop(events);
    disconnect_presence(&state, &account_id).await;
    state.realtime.unsubscribe(&account_id).await;
}

async fn sync(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<SyncQuery>,
) -> Result<Json<SyncResponse>, (StatusCode, Json<ErrorResponse>)> {
    let account_id = bearer_account_id(&state, &headers).await?;
    sync_payload(&state, &account_id, query.since.unwrap_or(0))
        .await
        .map(Json)
        .map_err(|message| error(StatusCode::INTERNAL_SERVER_ERROR, message))
}

async fn mark_conversation_read(
    State(state): State<AppState>,
    Path(conversation_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<MarkReadResponse>, (StatusCode, Json<ErrorResponse>)> {
    let account_id = bearer_account_id(&state, &headers).await?;
    if !protocol::valid_identifier(conversation_id.trim()) {
        return Err(error(StatusCode::BAD_REQUEST, "invalid_conversation"));
    }
    let read_at = storage::now_ms();
    let message_ids = state
        .db
        .mark_conversation_read(&account_id, conversation_id.trim(), read_at)
        .await
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"))?;
    let Some(message_ids) = message_ids else {
        return Err(error(StatusCode::NOT_FOUND, "conversation_not_found"));
    };
    state
        .db
        .touch_presence(&account_id, read_at)
        .await
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"))?;
    for event in message_ids {
        publish_stored_event(&state, event).await;
    }
    Ok(Json(MarkReadResponse { read_at }))
}

async fn mark_message_delivered(
    State(state): State<AppState>,
    Path(message_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<DeliveryAckResponse>, (StatusCode, Json<ErrorResponse>)> {
    let account_id = bearer_account_id(&state, &headers).await?;
    if !protocol::valid_identifier(message_id.trim()) {
        return Err(error(StatusCode::BAD_REQUEST, "invalid_message"));
    }
    let delivered_at = storage::now_ms();
    let event = state
        .db
        .mark_message_delivered(message_id.trim(), &account_id, delivered_at)
        .await
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"))?;
    if let Some(event) = event {
        publish_stored_event(&state, event).await;
        return Ok(Json(DeliveryAckResponse { delivered_at }));
    }

    let already_delivered = state
        .db
        .delivery_receipt(message_id.trim(), &account_id)
        .await
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"))?;
    already_delivered
        .map(|delivered_at| Json(DeliveryAckResponse { delivered_at }))
        .ok_or_else(|| error(StatusCode::NOT_FOUND, "message_not_found"))
}

async fn register_push_token(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<RegisterPushTokenRequest>,
) -> Result<Json<PushTokenResponse>, (StatusCode, Json<ErrorResponse>)> {
    let account_id = bearer_account_id(&state, &headers).await?;
    let token = request.token.trim();
    let device_id = request.device_id.trim();
    let platform = request.platform.trim().to_ascii_lowercase();
    if token.len() < 10
        || token.len() > 512
        || token.chars().any(char::is_control)
        || !protocol::valid_identifier(device_id)
        || !matches!(platform.as_str(), "android" | "ios")
    {
        return Err(error(StatusCode::BAD_REQUEST, "invalid_push_token"));
    }
    state
        .db
        .register_push_token(&account_id, device_id, token, &platform, storage::now_ms())
        .await
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"))?;
    state
        .db
        .bind_session_device(&account_id, bearer_token(&headers)?, device_id)
        .await
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"))?;
    Ok(Json(PushTokenResponse { accepted: true }))
}

async fn send_message(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<SendMessageRequest>,
) -> Result<Json<SendMessageResponse>, (StatusCode, Json<ErrorResponse>)> {
    let account_id = bearer_account_id(&state, &headers).await?;
    let Some(sender) = state
        .db
        .account_by_id(&account_id)
        .await
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"))?
    else {
        return Err(error(StatusCode::UNAUTHORIZED, "unauthorized"));
    };
    let conversation_id = request.conversation_id.trim();
    let client_message_id = request.client_message_id.trim();
    let envelopes = if request.envelopes.is_empty() {
        request.envelope.into_iter().collect::<Vec<_>>()
    } else {
        request.envelopes
    };
    let Some(primary) = envelopes.first() else {
        return Err(error(StatusCode::BAD_REQUEST, "invalid_message"));
    };
    if !protocol::valid_identifier(conversation_id)
        || !protocol::valid_identifier(client_message_id)
        || !valid_envelope_batch(&envelopes)
    {
        return Err(error(StatusCode::BAD_REQUEST, "invalid_message"));
    }
    for envelope in &envelopes {
        if client_message_id != envelope.message_id
            || envelope.conversation_id != conversation_id
            || !protocol::is_supported_envelope(envelope)
        {
            return Err(error(StatusCode::BAD_REQUEST, "invalid_message"));
        }
        let Some((_, recipient_server)) = enter_address_parts(&envelope.recipient) else {
            return Err(error(StatusCode::BAD_REQUEST, "invalid_message"));
        };
        if !same_server(&state.config.public_url, recipient_server)
            && state.config.federation_secret.is_none()
        {
            return Err(error(StatusCode::BAD_REQUEST, "federation_not_configured"));
        }
        if !envelope_belongs_to_account(envelope, &sender, &state.config.public_url) {
            return Err(error(StatusCode::FORBIDDEN, "sender_identity_mismatch"));
        }
        let registered_device = state
            .db
            .has_device_key(&account_id, &envelope.sender_device)
            .await
            .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"))?;
        if !registered_device {
            return Err(error(StatusCode::FORBIDDEN, "device_key_not_registered"));
        }
    }

    match state
        .db
        .can_write(&account_id, conversation_id)
        .await
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"))?
    {
        None => return Err(error(StatusCode::NOT_FOUND, "conversation_not_found")),
        Some(false) => return Err(error(StatusCode::FORBIDDEN, "conversation_read_only")),
        Some(true) => {}
    }
    let primary_json = serde_json::to_string(primary)
        .map_err(|_| error(StatusCode::BAD_REQUEST, "invalid_envelope"))?;
    let created_at = storage::now_ms();
    let message = state
        .db
        .insert_message(
            &account_id,
            conversation_id,
            client_message_id,
            &primary_json,
            created_at,
        )
        .await
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"))?
        .ok_or_else(|| error(StatusCode::NOT_FOUND, "conversation_not_found"))?;
    for envelope in envelopes.iter().skip(1) {
        let envelope_json = serde_json::to_string(envelope)
            .map_err(|_| error(StatusCode::BAD_REQUEST, "invalid_envelope"))?;
        let copy_id = format!(
            "copy:{account_id}:{}:{}",
            client_message_id, envelope.key_id
        );
        state
            .db
            .insert_message(
                &account_id,
                conversation_id,
                &copy_id,
                &envelope_json,
                created_at,
            )
            .await
            .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"))?
            .ok_or_else(|| error(StatusCode::NOT_FOUND, "conversation_not_found"))?;
    }
    if let Some(event) = state
        .db
        .event_for_message(&account_id, &message.id)
        .await
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"))?
    {
        publish_stored_event(&state, event).await;
    }
    for (index, envelope) in envelopes.iter().enumerate() {
        let envelope_json = serde_json::to_string(envelope)
            .map_err(|_| error(StatusCode::BAD_REQUEST, "invalid_envelope"))?;
        let Some((_, recipient_server)) = enter_address_parts(&envelope.recipient) else {
            return Err(error(StatusCode::BAD_REQUEST, "invalid_message"));
        };
        if same_server(&state.config.public_url, recipient_server) {
            deliver_local_message(
                &state,
                &sender,
                envelope,
                &envelope_json,
                created_at,
                index == 0,
            )
            .await?;
        } else {
            forward_federation_message(&state, &sender, envelope, created_at).await?;
        }
    }
    let cursor = state
        .db
        .cursor(&account_id)
        .await
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"))?;
    let message = message_response(message)
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "invalid_stored_envelope"))?;
    Ok(Json(SendMessageResponse {
        next_cursor: cursor,
        message,
    }))
}

fn valid_media_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

async fn upload_media(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<MediaUploadResponse>, (StatusCode, Json<ErrorResponse>)> {
    let account_id = bearer_account_id(&state, &headers).await?;
    let max_media_body = state.config.media_max_bytes.saturating_add(16);
    if body.is_empty() || body.len() > max_media_body {
        return Err(error(StatusCode::PAYLOAD_TOO_LARGE, "media_too_large"));
    }
    let media_id = headers
        .get("x-enter-media-id")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .trim();
    let conversation_id = headers
        .get("x-enter-conversation-id")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .trim();
    let recipient_address = headers
        .get("x-enter-recipient")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .trim();
    if !valid_media_id(media_id) || !protocol::valid_identifier(conversation_id) {
        return Err(error(StatusCode::BAD_REQUEST, "invalid_media_metadata"));
    }
    match state
        .db
        .can_write(&account_id, conversation_id)
        .await
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"))?
    {
        None => return Err(error(StatusCode::NOT_FOUND, "conversation_not_found")),
        Some(false) => return Err(error(StatusCode::FORBIDDEN, "conversation_read_only")),
        Some(true) => {}
    }

    let recipient_account_id = if recipient_address.is_empty() {
        account_id.clone()
    } else {
        let Some((handle, server)) = enter_address_parts(recipient_address) else {
            return Err(error(StatusCode::BAD_REQUEST, "invalid_media_recipient"));
        };
        if !same_server(&state.config.public_url, server) {
            return Err(error(StatusCode::BAD_REQUEST, "media_recipient_remote"));
        }
        let Some(recipient) = state
            .db
            .account_by_handle(handle)
            .await
            .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"))?
        else {
            return Err(error(StatusCode::NOT_FOUND, "media_recipient_not_found"));
        };
        recipient.id
    };
    state
        .db
        .store_media(
            &account_id,
            &recipient_account_id,
            conversation_id,
            media_id,
            &body,
            storage::now_ms(),
        )
        .await
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"))?;
    Ok(Json(MediaUploadResponse { accepted: true }))
}

async fn download_media(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(media_id): Path<String>,
) -> Result<Response, (StatusCode, Json<ErrorResponse>)> {
    let account_id = bearer_account_id(&state, &headers).await?;
    if !valid_media_id(&media_id) {
        return Err(error(StatusCode::NOT_FOUND, "media_not_found"));
    }
    let Some(bytes) = state
        .db
        .media_bytes(&account_id, &media_id)
        .await
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"))?
    else {
        return Err(error(StatusCode::NOT_FOUND, "media_not_found"));
    };
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .header(header::CACHE_CONTROL, "private, max-age=3600")
        .body(Body::from(bytes))
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "media_response_failed"))
}

async fn device_history(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<DeviceHistoryRequest>,
) -> Result<Json<DeviceHistoryResponse>, (StatusCode, Json<ErrorResponse>)> {
    let account_id = bearer_account_id(&state, &headers).await?;
    let Some(sender) = state
        .db
        .account_by_id(&account_id)
        .await
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"))?
    else {
        return Err(error(StatusCode::UNAUTHORIZED, "unauthorized"));
    };
    let history_size = request.entries.iter().try_fold(0usize, |size, entry| {
        serde_json::to_vec(&entry.envelope)
            .ok()
            .and_then(|value| size.checked_add(value.len()))
    });
    if request.entries.len() > 50 || history_size.is_none_or(|size| size > MAX_ENVELOPE_BATCH_BYTES)
    {
        return Err(error(StatusCode::BAD_REQUEST, "too_many_history_entries"));
    }

    let mut accepted = 0;
    for entry in request.entries {
        let envelope = &entry.envelope;
        if !protocol::valid_identifier(&entry.message_id)
            || !protocol::valid_identifier(&entry.conversation_id)
            || entry.message_id != envelope.message_id
            || entry.conversation_id != envelope.conversation_id
            || !protocol::is_supported_envelope(envelope)
            || !envelope_belongs_to_account(envelope, &sender, &state.config.public_url)
            || entry
                .source_key_id
                .as_deref()
                .is_some_and(|value| !protocol::valid_identifier(value))
        {
            return Err(error(StatusCode::BAD_REQUEST, "invalid_history_entry"));
        }
        let sender_registered = state
            .db
            .has_device_key(&account_id, &envelope.sender_device)
            .await
            .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"))?;
        let target_registered = state
            .db
            .has_device_key_id(&account_id, &envelope.key_id)
            .await
            .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"))?
            || state
                .db
                .has_account_key_id(&account_id, &envelope.key_id)
                .await
                .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"))?;
        if !sender_registered || !target_registered {
            return Err(error(StatusCode::FORBIDDEN, "device_key_not_registered"));
        }
        let envelope_json = serde_json::to_string(envelope)
            .map_err(|_| error(StatusCode::BAD_REQUEST, "invalid_history_entry"))?;
        if state
            .db
            .add_device_message_copy(
                &account_id,
                &entry.conversation_id,
                &entry.message_id,
                entry.source_key_id.as_deref(),
                &envelope.key_id,
                &envelope_json,
            )
            .await
            .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"))?
        {
            accepted += 1;
        }
    }

    let next_cursor = state
        .db
        .cursor(&account_id)
        .await
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"))?;
    Ok(Json(DeviceHistoryResponse {
        accepted,
        next_cursor,
    }))
}

#[cfg(test)]
mod tests {
    use super::{
        constant_time_equal, conversation_response, enter_address_parts,
        envelope_belongs_to_account, federation_authorized, federation_delivery_error,
        federation_urls, is_embedded_app_origin, is_local_dev_origin, normalize_server, origin,
        realtime_error_payload, realtime_hello_error, realtime_origin_allowed, same_server,
        valid_envelope_batch, RealtimeEvent, RealtimeHello, RealtimeHub, MAX_ENVELOPES_PER_MESSAGE,
        REALTIME_PROTOCOL_VERSION,
    };
    use axum::http::{HeaderMap, HeaderValue};

    #[test]
    fn local_server_aliases_match() {
        assert_eq!(normalize_server("http://localhost:8080"), "127.0.0.1:8080");
        assert_eq!(normalize_server("[::1]:8080"), "127.0.0.1:8080");
        assert!(same_server("http://127.0.0.1:8080", "localhost:8080"));
        assert!(same_server("http://localhost:8080", "[::1]:8080"));
        assert!(!same_server("http://127.0.0.1:8080", "localhost:8081"));
    }

    #[test]
    fn enter_addresses_require_handle_and_server() {
        assert_eq!(
            enter_address_parts("alice@example.test"),
            Some(("alice", "example.test"))
        );
        assert!(enter_address_parts("alice@").is_none());
        assert!(enter_address_parts("@example.test").is_none());
        assert!(enter_address_parts("alice").is_none());
        assert!(enter_address_parts("alice@example.test/path").is_none());
        assert!(enter_address_parts("alice@evil@example.test").is_none());
    }

    #[test]
    fn envelope_sender_must_match_authenticated_account() {
        let account = super::storage::StoredAccount {
            id: "account-1".to_owned(),
            name: "Alice".to_owned(),
            handle: "alice".to_owned(),
            password_hash: "hash".to_owned(),
        };
        let envelope = super::protocol::EncryptedEnvelope {
            protocol: super::protocol::PROTOCOL_VERSION.to_owned(),
            message_id: "message-1".to_owned(),
            conversation_id: "conversation-1".to_owned(),
            sender: "alice@example.test".to_owned(),
            recipient: "bob@example.test".to_owned(),
            sender_device: "device-1".to_owned(),
            key_id: "key-1".to_owned(),
            created_at: "2026-08-28T00:00:00Z".to_owned(),
            nonce: "nonce".to_owned(),
            ephemeral_public_key: "ephemeral".to_owned(),
            ciphertext: "ciphertext".to_owned(),
            associated_data: "aad".to_owned(),
            signature: "signature".to_owned(),
        };
        assert!(envelope_belongs_to_account(
            &envelope,
            &account,
            "https://example.test"
        ));
        let mut forged = envelope.clone();
        forged.sender = "mallory@example.test".to_owned();
        assert!(!envelope_belongs_to_account(
            &forged,
            &account,
            "https://example.test"
        ));
        forged.sender = "alice@evil.example".to_owned();
        assert!(!envelope_belongs_to_account(
            &forged,
            &account,
            "https://example.test"
        ));
    }

    #[test]
    fn envelope_fanout_is_bounded() {
        let envelope = super::protocol::EncryptedEnvelope {
            protocol: super::protocol::PROTOCOL_VERSION.to_owned(),
            message_id: "message-1".to_owned(),
            conversation_id: "conversation-1".to_owned(),
            sender: "alice@example.test".to_owned(),
            recipient: "bob@example.test".to_owned(),
            sender_device: "device-1".to_owned(),
            key_id: "key-1".to_owned(),
            created_at: "2026-08-28T00:00:00Z".to_owned(),
            nonce: "nonce".to_owned(),
            ephemeral_public_key: "ephemeral".to_owned(),
            ciphertext: "ciphertext".to_owned(),
            associated_data: "aad".to_owned(),
            signature: "signature".to_owned(),
        };
        assert!(valid_envelope_batch(std::slice::from_ref(&envelope)));
        assert!(!valid_envelope_batch(&vec![
            envelope;
            MAX_ENVELOPES_PER_MESSAGE + 1
        ]));
    }

    #[test]
    fn federation_auth_uses_the_bearer_secret_and_transport_policy() {
        assert!(constant_time_equal("secret", "secret"));
        assert!(!constant_time_equal("secret", "other"));
        let mut headers = HeaderMap::new();
        headers.insert("authorization", HeaderValue::from_static("Bearer secret"));
        assert!(federation_authorized(&headers, Some("secret")));
        assert!(!federation_authorized(&headers, Some("wrong")));
        assert!(!federation_authorized(&headers, None));
        assert_eq!(
            federation_urls("remote.example:50121", false),
            vec!["https://remote.example:50121/enter/v1/federation/deliveries"]
        );
        assert_eq!(
            federation_urls("remote.example:50121", true),
            vec![
                "https://remote.example:50121/enter/v1/federation/deliveries",
                "http://remote.example:50121/enter/v1/federation/deliveries"
            ]
        );
    }

    #[test]
    fn federation_delivery_is_bound_to_both_servers() {
        let envelope = super::protocol::EncryptedEnvelope {
            protocol: super::protocol::PROTOCOL_VERSION.to_owned(),
            message_id: "message-1".to_owned(),
            conversation_id: "conversation-1".to_owned(),
            sender: "alice@source.example".to_owned(),
            recipient: "bob@target.example".to_owned(),
            sender_device: "device-1".to_owned(),
            key_id: "key-1".to_owned(),
            created_at: "2026-08-28T00:00:00Z".to_owned(),
            nonce: "nonce".to_owned(),
            ephemeral_public_key: "ephemeral".to_owned(),
            ciphertext: "ciphertext".to_owned(),
            associated_data: "aad".to_owned(),
            signature: "signature".to_owned(),
        };
        let delivery = super::protocol::FederationDelivery {
            protocol: super::protocol::PROTOCOL_VERSION.to_owned(),
            delivery_id: "source.example:message-1:key-1".to_owned(),
            sender_server: "https://source.example".to_owned(),
            sender_name: "Alice".to_owned(),
            sender_avatar: "alice".to_owned(),
            message: super::protocol::FederationMessage {
                id: envelope.message_id.clone(),
                conversation_id: envelope.conversation_id.clone(),
                created_at: 1,
                envelope,
            },
        };
        assert_eq!(
            federation_delivery_error(&delivery, "https://target.example"),
            None
        );
        let mut forged = delivery.clone();
        forged.sender_server = "https://mallory.example".to_owned();
        assert_eq!(
            federation_delivery_error(&forged, "https://target.example"),
            Some("sender_server_mismatch")
        );
        let mut misrouted = delivery;
        misrouted.message.envelope.recipient = "bob@other.example".to_owned();
        assert_eq!(
            federation_delivery_error(&misrouted, "https://target.example"),
            Some("wrong_recipient_server")
        );
    }

    #[test]
    fn local_presence_is_not_hidden_by_public_url_aliases() {
        let response = conversation_response(
            super::storage::StoredConversation {
                id: "direct:1".to_owned(),
                name: "Bob".to_owned(),
                handle: Some("bob@old-host:8080".to_owned()),
                avatar: "bob".to_owned(),
                subtitle: None,
                can_write: true,
                last_message: String::new(),
                last_message_at: None,
                pinned: false,
                online: false,
                last_seen_at: Some(99_500),
                unread: 0,
            },
            "server-id",
            100_000,
        );
        assert!(response.online);
        assert_eq!(response.last_seen_at, Some(99_500));
    }

    #[test]
    fn realtime_receipt_events_keep_wire_names() {
        let value = serde_json::to_value(RealtimeEvent::ReadReceipt {
            cursor: 2,
            message_id: "message-1".to_owned(),
            read_at: 42,
        })
        .expect("serialize realtime event");
        assert_eq!(value["type"], "readReceipt");
        assert_eq!(value["messageId"], "message-1");
        assert_eq!(value["readAt"], 42);
    }

    #[test]
    fn realtime_presence_events_keep_wire_names() {
        let value = serde_json::to_value(RealtimeEvent::Presence {
            conversation_id: "conversation-1".to_owned(),
            online: false,
            last_seen_at: 42,
        })
        .expect("serialize realtime presence event");
        assert_eq!(value["type"], "presence");
        assert_eq!(value["conversationId"], "conversation-1");
        assert_eq!(value["online"], false);
        assert_eq!(value["lastSeenAt"], 42);
    }

    #[test]
    fn realtime_origin_requires_the_configured_scheme_and_authority() {
        assert_eq!(
            origin("https://example.test/path"),
            Some("https://example.test".to_owned())
        );
        let mut headers = HeaderMap::new();
        headers.insert("origin", HeaderValue::from_static("https://example.test"));
        assert!(realtime_origin_allowed(&headers, "https://example.test"));
        headers.insert("origin", HeaderValue::from_static("http://example.test"));
        assert!(!realtime_origin_allowed(&headers, "https://example.test"));
        headers.insert(
            "origin",
            HeaderValue::from_static("https://example.test/not-an-origin"),
        );
        assert!(!realtime_origin_allowed(&headers, "https://example.test"));
        headers.insert("origin", HeaderValue::from_static("http://tauri.localhost"));
        assert!(realtime_origin_allowed(&headers, "https://example.test"));
        assert!(is_embedded_app_origin("tauri://localhost"));
        assert!(!is_embedded_app_origin("https://evil.example"));
        assert!(is_local_dev_origin("http://localhost:8081"));
        assert!(is_local_dev_origin("http://192.168.0.160:8081"));
        assert!(is_local_dev_origin("http://127.0.0.1:1420"));
        assert!(!is_local_dev_origin("http://evil.example:8081"));
        assert!(!is_local_dev_origin("http://192.168.0.160:3000"));
        headers.insert(
            "origin",
            HeaderValue::from_static("http://192.168.0.160:8081"),
        );
        assert!(realtime_origin_allowed(&headers, "http://127.0.0.1:50121"));
        assert!(realtime_origin_allowed(
            &HeaderMap::new(),
            "https://example.test"
        ));
    }

    #[test]
    fn realtime_handshake_errors_are_stable_and_secret_free() {
        let valid = RealtimeHello {
            kind: "hello".to_owned(),
            version: REALTIME_PROTOCOL_VERSION,
            token: "opaque-token".to_owned(),
            since: Some(7),
        };
        assert_eq!(realtime_hello_error(&valid), None);
        assert_eq!(
            realtime_hello_error(&RealtimeHello {
                kind: "hello".to_owned(),
                version: 99,
                ..valid
            }),
            Some("unsupported_protocol")
        );
        let payload: serde_json::Value =
            serde_json::from_str(&realtime_error_payload("unauthorized")).expect("error JSON");
        assert_eq!(payload["type"], "error");
        assert_eq!(payload["code"], "unauthorized");
        assert!(payload.get("token").is_none());
    }

    #[tokio::test]
    async fn presence_stays_online_until_last_realtime_session_closes() {
        let hub = RealtimeHub::default();
        assert!(hub.try_connect("account-1").await.is_ok_and(|first| first));
        assert!(hub.try_connect("account-1").await.is_ok_and(|first| !first));
        assert!(!hub.presence_disconnected("account-1").await);
        assert!(hub.presence_disconnected("account-1").await);
        assert!(!hub.presence_disconnected("account-1").await);
    }

    #[tokio::test]
    async fn realtime_limits_connections_per_account() {
        let hub = RealtimeHub::default();
        for _ in 0..4 {
            assert!(hub.try_connect("account-1").await.is_ok());
        }
        assert!(hub.try_connect("account-1").await.is_err());
        assert!(!hub.presence_disconnected("account-1").await);
        assert!(!hub.presence_disconnected("account-1").await);
        assert!(!hub.presence_disconnected("account-1").await);
        assert!(hub.presence_disconnected("account-1").await);
    }
}

async fn create_conversation(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<CreateConversationRequest>,
) -> Result<Json<ConversationResponse>, (StatusCode, Json<ErrorResponse>)> {
    let account_id = bearer_account_id(&state, &headers).await?;
    let peer_address = request.peer_address.trim();
    let name = request.name.trim();
    let avatar = request.avatar.trim();
    let Some((_, _)) = enter_address_parts(peer_address) else {
        return Err(error(StatusCode::BAD_REQUEST, "invalid_conversation"));
    };
    if peer_address.len() > 320
        || !valid_display_text(name, 160)
        || !valid_display_text(avatar, 320)
        || request
            .subtitle
            .as_deref()
            .is_some_and(|value| !valid_display_text(value, 320))
    {
        return Err(error(StatusCode::BAD_REQUEST, "invalid_conversation"));
    }
    let conversation = state
        .db
        .create_direct_conversation(
            &account_id,
            peer_address,
            name,
            avatar,
            request.subtitle.as_deref(),
            storage::now_ms(),
        )
        .await
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"))?;
    Ok(Json(conversation_response(
        conversation,
        &state.server_id,
        storage::now_ms(),
    )))
}

async fn register_device_key(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<RegisterDeviceKeyRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ErrorResponse>)> {
    let account_id = bearer_account_id(&state, &headers).await?;
    let device_id = request.device_id.trim();
    let key_id = request.key_id.trim();
    if !protocol::valid_identifier(device_id)
        || !protocol::valid_identifier(key_id)
        || !valid_key_material(request.encryption_public_key.trim())
        || !valid_key_material(request.signing_public_key.trim())
        || request.created_at <= 0
    {
        return Err(error(StatusCode::BAD_REQUEST, "invalid_device_key"));
    }
    let account_key = match (
        request.account_key_id.as_deref(),
        request.account_encryption_public_key.as_deref(),
    ) {
        (Some(key_id), Some(public_key))
            if protocol::valid_identifier(key_id.trim())
                && valid_key_material(public_key.trim()) =>
        {
            Some((key_id.trim().to_owned(), public_key.trim().to_owned()))
        }
        (None, None) => None,
        _ => return Err(error(StatusCode::BAD_REQUEST, "invalid_account_key")),
    };
    state
        .db
        .register_device_key(
            &account_id,
            &storage::StoredDeviceKey {
                device_id: device_id.to_owned(),
                key_id: key_id.to_owned(),
                encryption_public_key: request.encryption_public_key.trim().to_owned(),
                signing_public_key: request.signing_public_key.trim().to_owned(),
                created_at: request.created_at,
            },
            storage::now_ms(),
        )
        .await
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"))?;
    state
        .db
        .upsert_device(
            &account_id,
            device_id,
            "unknown",
            None,
            None,
            storage::now_ms(),
        )
        .await
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"))?;
    state
        .db
        .bind_session_device(&account_id, bearer_token(&headers)?, device_id)
        .await
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"))?;
    if let Some((key_id, public_key)) = account_key {
        state
            .db
            .register_account_key(&account_id, &key_id, &public_key, storage::now_ms())
            .await
            .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"))?;
    }
    Ok(Json(serde_json::json!({ "accepted": true })))
}

async fn public_keys(
    State(state): State<AppState>,
    Path(handle): Path<String>,
    Query(query): Query<SearchQuery>,
) -> Result<Json<protocol::PublicKeyDirectory>, (StatusCode, Json<ErrorResponse>)> {
    let requested_handle = handle.trim().trim_start_matches('@').to_lowercase();
    let search_prefix = query
        .q
        .as_deref()
        .map(|value| value.trim().trim_start_matches('@').to_lowercase())
        .filter(|value| !value.is_empty());
    if (!requested_handle.is_empty() && !protocol::valid_handle(&requested_handle))
        || search_prefix
            .as_deref()
            .is_some_and(|value| !protocol::valid_handle(value))
        || (requested_handle.is_empty() && search_prefix.is_none())
    {
        return Err(error(StatusCode::BAD_REQUEST, "invalid_handle"));
    }
    let Some(account) = match search_prefix.as_deref() {
        Some(prefix) => state.db.account_by_handle_prefix(prefix).await,
        None => state.db.account_by_handle(&requested_handle).await,
    }
    .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"))?
    else {
        return Err(error(StatusCode::NOT_FOUND, "user_not_found"));
    };
    let handle = account.handle;
    let keys = state
        .db
        .device_keys_for_handle(&handle)
        .await
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"))?
        .unwrap_or_default();
    let account_key = state
        .db
        .account_key_for_handle(&handle)
        .await
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"))?;
    Ok(Json(protocol::PublicKeyDirectory {
        id: account.id,
        handle,
        name: account.name,
        server: state.config.public_url.clone(),
        server_id: state.server_id.clone(),
        devices: keys
            .into_iter()
            .map(|key| protocol::DeviceKeyBundle {
                device_id: key.device_id,
                key_id: key.key_id,
                encryption_public_key: key.encryption_public_key,
                signing_public_key: key.signing_public_key,
                created_at: key.created_at,
            })
            .collect(),
        account_key: account_key.map(|key| protocol::AccountKeyBundle {
            key_id: key.key_id,
            encryption_public_key: key.encryption_public_key,
        }),
    }))
}

#[tokio::main]
async fn main() {
    let _ = dotenvy::dotenv();
    let config = config::ServerConfig::from_env();
    let storage = storage::Storage::open(&config.database_url)
        .await
        .expect("open database");
    let server_id = storage
        .ensure_server_id()
        .await
        .expect("ensure server identity");
    storage
        .canonicalize_local_conversations(&config.public_url)
        .await
        .expect("canonicalize local conversations");
    let state = AppState {
        db: storage,
        config: config.clone(),
        server_id,
        realtime: RealtimeHub::default(),
    };
    let max_media_body = state.config.media_max_bytes.saturating_add(16);
    let app = Router::new()
        .route("/health", get(health))
        .route("/.well-known/enter", get(protocol_discovery))
        .route("/server/logo", get(server_logo))
        .route("/auth/register", post(register))
        .route("/auth/login", post(login))
        .route("/auth/logout", post(logout))
        .route("/auth/change-password", post(change_password))
        .route(
            "/api/v1/account/settings",
            get(get_account_settings).patch(patch_account_settings),
        )
        .route("/api/v1/sessions", get(list_sessions))
        .route("/api/v1/sessions/:session_id", delete(revoke_session))
        .route(
            "/api/v1/sessions/revoke-others",
            post(revoke_other_sessions),
        )
        .route("/api/v1/devices", get(list_devices))
        .route("/api/v1/devices/:device_id", delete(revoke_device))
        .route("/api/v1/sync", get(sync))
        .route("/api/v1/realtime", get(realtime))
        .route("/api/v1/messages", post(send_message))
        .route(
            "/api/v1/media",
            post(upload_media).layer(DefaultBodyLimit::max(max_media_body)),
        )
        .route("/enter/v1/federation/deliveries", post(federation_delivery))
        .route("/api/v1/media/:media_id", get(download_media))
        .route(
            "/api/v1/conversations/:conversation_id/read",
            post(mark_conversation_read),
        )
        .route(
            "/api/v1/messages/:message_id/delivered",
            post(mark_message_delivered),
        )
        .route("/api/v1/push-tokens", post(register_push_token))
        .route("/api/v1/device-history", post(device_history))
        .route("/api/v1/conversations", post(create_conversation))
        .route("/enter/v1/keys", post(register_device_key))
        .route("/enter/v1/keys/:handle", get(public_keys))
        .with_state(state)
        .layer(DefaultBodyLimit::max(MAX_JSON_BODY_BYTES))
        .layer(CorsLayer::permissive().allow_private_network(true));
    let listener = tokio::net::TcpListener::bind(config.address)
        .await
        .expect("bind server");
    println!(
        "{} server listening on http://{}",
        config.name, config.address
    );
    axum::serve(listener, app).await.expect("serve server");
}
