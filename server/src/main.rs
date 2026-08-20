use argon2::{
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use axum::{
    extract::{Path, Query, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::Response,
    routing::{get, post},
    Json, Router,
};
use rand_core::OsRng;
use serde::{Deserialize, Serialize};
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
}

#[derive(Serialize)]
struct ProtocolErrorResponse {
    error: &'static str,
}

#[derive(Deserialize)]
struct AuthRequest {
    name: Option<String>,
    handle: String,
    password: String,
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

#[derive(Serialize)]
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MessageResponse {
    id: String,
    conversation_id: String,
    author: String,
    created_at: i64,
    envelope: protocol::EncryptedEnvelope,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncResponse {
    next_cursor: i64,
    conversations: Vec<ConversationResponse>,
    messages: Vec<MessageResponse>,
    read_receipts: Vec<ReadReceiptResponse>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReadReceiptResponse {
    message_id: String,
    read_at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MarkReadResponse {
    read_at: i64,
}

#[derive(Deserialize)]
struct SyncQuery {
    since: Option<i64>,
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

async fn health(State(state): State<AppState>) -> Json<Health> {
    Json(Health {
        service: "enter-server",
        status: "ok",
        protocol: protocol::PROTOCOL_VERSION,
        server_name: state.config.name.clone(),
        server_id: state.server_id.clone(),
        logo: state.config.logo(),
    })
}

async fn protocol_discovery(State(state): State<AppState>) -> Json<protocol::DiscoveryDocument> {
    Json(protocol::discovery(
        state.config.public_url.clone(),
        state.server_id.clone(),
        state.config.name.clone(),
        state.config.logo(),
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

async fn federation_delivery(
    State(state): State<AppState>,
    Json(delivery): Json<protocol::FederationDelivery>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ProtocolErrorResponse>)> {
    if !protocol::is_supported_delivery(&delivery) {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ProtocolErrorResponse {
                error: "invalid_federation_delivery",
            }),
        ));
    }

    let envelope_json = serde_json::to_string(&delivery.envelope).map_err(|_| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ProtocolErrorResponse {
                error: "envelope_storage_failed",
            }),
        )
    })?;
    let inserted = state
        .db
        .store_federation_delivery(
            &delivery.delivery_id,
            &delivery.envelope.message_id,
            &delivery.envelope.conversation_id,
            &delivery.sender_server,
            &envelope_json,
            storage::now_ms(),
        )
        .await
        .map_err(|_| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ProtocolErrorResponse {
                    error: "envelope_storage_failed",
                }),
            )
        })?;

    // The server deliberately stores ciphertext as an opaque envelope. Decryption and
    // device delivery happen only after the identity/session layer is added.
    Ok(Json(serde_json::json!({
        "protocol": protocol::PROTOCOL_VERSION,
        "delivery_id": delivery.delivery_id,
        "accepted": true,
        "stored_as": "opaque-federation-envelope",
        "duplicate": !inserted,
    })))
}

fn error(status: StatusCode, message: &'static str) -> (StatusCode, Json<ErrorResponse>) {
    (status, Json(ErrorResponse { error: message }))
}

fn enter_address_parts(address: &str) -> Option<(&str, &str)> {
    let (handle, server) = address.trim().split_once('@')?;
    (!handle.is_empty() && !server.is_empty()).then_some((handle, server))
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

async fn deliver_local_message(
    state: &AppState,
    sender_account_id: &str,
    envelope: &protocol::EncryptedEnvelope,
    envelope_json: &str,
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
    if recipient.id == sender_account_id {
        return Ok(());
    }

    let (sender_handle, _) =
        enter_address_parts(&envelope.sender).unwrap_or((envelope.sender.as_str(), ""));
    let sender_address = canonical_address(&state.config.public_url, sender_handle);
    let sender = state
        .db
        .account_by_handle(sender_handle)
        .await
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"))?;
    let delivery_id = format!("{}:{}", envelope.message_id, envelope.key_id);
    state
        .db
        .deliver_message(
            &recipient.id,
            &envelope.conversation_id,
            &sender_address,
            sender
                .as_ref()
                .map(|value| value.name.as_str())
                .unwrap_or(sender_handle),
            sender_handle,
            &delivery_id,
            envelope_json,
            storage::now_ms(),
        )
        .await
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"))?;
    Ok(())
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
    let name = request.name.unwrap_or_default().trim().to_owned();
    let handle = request.handle.trim().trim_start_matches('@').to_lowercase();
    if name.is_empty() || handle.is_empty() || request.password.len() < 8 {
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
        .store_session(&response.token, &account.id, storage::now_ms())
        .await
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"))?;
    Ok(Json(response))
}

async fn login(
    State(state): State<AppState>,
    Json(request): Json<AuthRequest>,
) -> Result<Json<AuthResponse>, (StatusCode, Json<ErrorResponse>)> {
    let handle = request.handle.trim().trim_start_matches('@').to_lowercase();
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
        .store_session(&response.token, &response.profile.id, storage::now_ms())
        .await
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"))?;
    Ok(Json(response))
}

async fn bearer_account_id(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<String, (StatusCode, Json<ErrorResponse>)> {
    let Some(value) = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
    else {
        return Err(error(StatusCode::UNAUTHORIZED, "unauthorized"));
    };
    let Some(token) = value.strip_prefix("Bearer ") else {
        return Err(error(StatusCode::UNAUTHORIZED, "unauthorized"));
    };
    state
        .db
        .account_id_for_session(token)
        .await
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"))?
        .ok_or_else(|| error(StatusCode::UNAUTHORIZED, "unauthorized"))
}

fn conversation_response(
    value: storage::StoredConversation,
    server_id: &str,
    _local_server: &str,
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
        envelope: serde_json::from_str(&value.envelope_json)?,
    })
}

async fn sync(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<SyncQuery>,
) -> Result<Json<SyncResponse>, (StatusCode, Json<ErrorResponse>)> {
    let account_id = bearer_account_id(&state, &headers).await?;
    let now = storage::now_ms();
    state
        .db
        .touch_presence(&account_id, now)
        .await
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"))?;
    let snapshot = state
        .db
        .sync(&account_id, query.since.unwrap_or(0).max(0))
        .await
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"))?;
    let messages = snapshot
        .messages
        .into_iter()
        .map(message_response)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "invalid_stored_envelope"))?;
    Ok(Json(SyncResponse {
        next_cursor: snapshot.cursor,
        conversations: snapshot
            .conversations
            .into_iter()
            .map(|conversation| {
                conversation_response(
                    conversation,
                    &state.server_id,
                    &state.config.public_url,
                    now,
                )
            })
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
    }))
}

async fn mark_conversation_read(
    State(state): State<AppState>,
    Path(conversation_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<MarkReadResponse>, (StatusCode, Json<ErrorResponse>)> {
    let account_id = bearer_account_id(&state, &headers).await?;
    let read_at = storage::now_ms();
    let marked = state
        .db
        .mark_conversation_read(&account_id, conversation_id.trim(), read_at)
        .await
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"))?;
    if !marked {
        return Err(error(StatusCode::NOT_FOUND, "conversation_not_found"));
    }
    state
        .db
        .touch_presence(&account_id, read_at)
        .await
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"))?;
    Ok(Json(MarkReadResponse { read_at }))
}

async fn send_message(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<SendMessageRequest>,
) -> Result<Json<SendMessageResponse>, (StatusCode, Json<ErrorResponse>)> {
    let account_id = bearer_account_id(&state, &headers).await?;
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
    if conversation_id.is_empty() || client_message_id.is_empty() {
        return Err(error(StatusCode::BAD_REQUEST, "invalid_message"));
    }
    for envelope in &envelopes {
        if client_message_id != envelope.message_id
            || envelope.conversation_id != conversation_id
            || !protocol::is_supported_envelope(envelope)
            || envelope.ciphertext.len() > 1_500_000
        {
            return Err(error(StatusCode::BAD_REQUEST, "invalid_message"));
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
    let message = state
        .db
        .insert_message(
            &account_id,
            conversation_id,
            client_message_id,
            &primary_json,
            storage::now_ms(),
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
                storage::now_ms(),
            )
            .await
            .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"))?
            .ok_or_else(|| error(StatusCode::NOT_FOUND, "conversation_not_found"))?;
    }
    for envelope in &envelopes {
        let envelope_json = serde_json::to_string(envelope)
            .map_err(|_| error(StatusCode::BAD_REQUEST, "invalid_envelope"))?;
        deliver_local_message(&state, &account_id, envelope, &envelope_json).await?;
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

async fn device_history(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<DeviceHistoryRequest>,
) -> Result<Json<DeviceHistoryResponse>, (StatusCode, Json<ErrorResponse>)> {
    let account_id = bearer_account_id(&state, &headers).await?;
    if request.entries.len() > 50 {
        return Err(error(StatusCode::BAD_REQUEST, "too_many_history_entries"));
    }

    let mut accepted = 0;
    for entry in request.entries {
        let envelope = &entry.envelope;
        if entry.message_id != envelope.message_id
            || entry.conversation_id != envelope.conversation_id
            || !protocol::is_supported_envelope(envelope)
            || envelope.ciphertext.len() > 1_500_000
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
    use super::{conversation_response, enter_address_parts, normalize_server, same_server};

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
            "https://current-host.example",
            100_000,
        );
        assert!(response.online);
        assert_eq!(response.last_seen_at, Some(99_500));
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
    if peer_address.is_empty()
        || peer_address.len() > 320
        || enter_address_parts(peer_address).is_none()
        || name.is_empty()
        || name.len() > 160
        || avatar.is_empty()
        || avatar.len() > 320
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
        &state.config.public_url,
        storage::now_ms(),
    )))
}

async fn register_device_key(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<RegisterDeviceKeyRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ErrorResponse>)> {
    let account_id = bearer_account_id(&state, &headers).await?;
    if request.device_id.trim().is_empty()
        || request.key_id.trim().is_empty()
        || request.encryption_public_key.trim().is_empty()
        || request.signing_public_key.trim().is_empty()
        || request.encryption_public_key.len() > 16_384
        || request.signing_public_key.len() > 16_384
    {
        return Err(error(StatusCode::BAD_REQUEST, "invalid_device_key"));
    }
    state
        .db
        .register_device_key(
            &account_id,
            &storage::StoredDeviceKey {
                device_id: request.device_id,
                key_id: request.key_id,
                encryption_public_key: request.encryption_public_key,
                signing_public_key: request.signing_public_key,
                created_at: request.created_at,
            },
            storage::now_ms(),
        )
        .await
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"))?;
    match (
        request.account_key_id.as_deref(),
        request.account_encryption_public_key.as_deref(),
    ) {
        (Some(key_id), Some(public_key))
            if !key_id.trim().is_empty()
                && !public_key.trim().is_empty()
                && public_key.len() <= 16_384 =>
        {
            state
                .db
                .register_account_key(
                    &account_id,
                    key_id.trim(),
                    public_key.trim(),
                    storage::now_ms(),
                )
                .await
                .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"))?;
        }
        (None, None) => {}
        _ => return Err(error(StatusCode::BAD_REQUEST, "invalid_account_key")),
    }
    Ok(Json(serde_json::json!({ "accepted": true })))
}

async fn public_keys(
    State(state): State<AppState>,
    Path(handle): Path<String>,
) -> Result<Json<protocol::PublicKeyDirectory>, (StatusCode, Json<ErrorResponse>)> {
    let handle = handle.trim().trim_start_matches('@').to_lowercase();
    if handle.is_empty() {
        return Err(error(StatusCode::BAD_REQUEST, "invalid_handle"));
    }
    let Some(account) = state
        .db
        .account_by_handle(&handle)
        .await
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failed"))?
    else {
        return Err(error(StatusCode::NOT_FOUND, "user_not_found"));
    };
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
    };
    let app = Router::new()
        .route("/health", get(health))
        .route("/.well-known/enter", get(protocol_discovery))
        .route("/server/logo", get(server_logo))
        .route("/auth/register", post(register))
        .route("/auth/login", post(login))
        .route("/api/v1/sync", get(sync))
        .route("/api/v1/messages", post(send_message))
        .route(
            "/api/v1/conversations/:conversation_id/read",
            post(mark_conversation_read),
        )
        .route("/api/v1/device-history", post(device_history))
        .route("/api/v1/conversations", post(create_conversation))
        .route("/enter/v1/keys", post(register_device_key))
        .route("/enter/v1/keys/:handle", get(public_keys))
        .route("/enter/v1/federation/deliveries", post(federation_delivery))
        .with_state(state)
        .layer(CorsLayer::permissive());
    let listener = tokio::net::TcpListener::bind(config.address)
        .await
        .expect("bind server");
    println!(
        "{} server listening on http://{}",
        config.name, config.address
    );
    axum::serve(listener, app).await.expect("serve server");
}
