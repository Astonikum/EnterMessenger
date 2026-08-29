use rand_core::{OsRng, RngCore};
use rusqlite::{params, Connection, OptionalExtension, Result as SqlResult, Transaction};
use serde::{Deserialize, Serialize};
use sqlx::{postgres::PgPoolOptions, PgPool, Row};
use std::{
    collections::HashMap,
    fmt, fs,
    path::Path,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

pub const SESSION_TTL_MS: i64 = 30 * 24 * 60 * 60 * 1_000;
const MAX_SYNC_EVENTS: i64 = 1_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccountSettings {
    pub show_online: bool,
    pub show_last_seen: bool,
    pub read_receipts: bool,
    pub typing_indicators: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StoredFolder {
    pub id: String,
    pub name: String,
    pub template: String,
    pub icon: String,
    pub chat_ids: Vec<String>,
}

impl Default for AccountSettings {
    fn default() -> Self {
        Self {
            show_online: true,
            show_last_seen: true,
            read_receipts: true,
            typing_indicators: true,
        }
    }
}

#[derive(Debug, Clone)]
pub struct StoredSession {
    pub id: String,
    pub device_id: Option<String>,
    pub platform: String,
    pub device_name: Option<String>,
    pub app_version: Option<String>,
    pub created_at: i64,
    pub expires_at: i64,
    pub last_seen_at: Option<i64>,
    pub current: bool,
}

#[derive(Debug, Clone)]
pub struct StoredDevice {
    pub device_id: String,
    pub platform: String,
    pub name: Option<String>,
    pub app_version: Option<String>,
    pub created_at: i64,
    pub last_seen_at: Option<i64>,
    pub revoked_at: Option<i64>,
}

fn legacy_session_id(token: &str) -> String {
    let mut first = 0xcbf29ce484222325u64;
    let mut second = 0x84222325cbf29ce4u64;
    for byte in token.as_bytes() {
        first = (first ^ u64::from(*byte)).wrapping_mul(0x100000001b3);
        second = (second ^ u64::from((*byte).rotate_left(3))).wrapping_mul(0x100000001b3);
    }
    let mut bytes = [0u8; 16];
    bytes[..8].copy_from_slice(&first.to_be_bytes());
    bytes[8..].copy_from_slice(&second.to_be_bytes());
    format!("legacy-{}", Uuid::new_v8(bytes))
}

fn new_server_id() -> String {
    let mut bytes = [0u8; 16];
    OsRng.fill_bytes(&mut bytes);
    Uuid::new_v8(bytes).to_string()
}

fn server_without_scheme(value: &str) -> String {
    value
        .trim()
        .trim_end_matches('/')
        .strip_prefix("http://")
        .or_else(|| value.trim().trim_end_matches('/').strip_prefix("https://"))
        .unwrap_or(value.trim().trim_end_matches('/'))
        .to_lowercase()
}

fn server_port(value: &str) -> Option<String> {
    let value = server_without_scheme(value);
    value.rsplit_once(':').map(|(_, port)| port.to_owned())
}

fn is_loopback_server(value: &str) -> bool {
    let normalized = server_without_scheme(value);
    let host = normalized
        .rsplit_once(':')
        .map(|(host, _)| host)
        .unwrap_or(&normalized)
        .trim_matches(['[', ']']);
    host == "localhost" || host == "127.0.0.1" || host == "0.0.0.0" || host == "::1"
}

fn same_local_server(local: &str, candidate: &str) -> bool {
    server_without_scheme(local) == server_without_scheme(candidate)
        || (is_loopback_server(candidate)
            && server_port(local)
                .zip(server_port(candidate))
                .is_some_and(|(local_port, candidate_port)| local_port == candidate_port))
}

fn canonical_server(value: &str) -> String {
    server_without_scheme(value)
}

#[derive(Debug, Clone)]
pub struct StoredAccount {
    pub id: String,
    pub name: String,
    pub handle: String,
    pub password_hash: String,
}

#[derive(Debug, Clone)]
pub struct StoredConversation {
    pub id: String,
    pub name: String,
    pub handle: Option<String>,
    pub avatar: String,
    pub subtitle: Option<String>,
    pub can_write: bool,
    pub last_message: String,
    pub last_message_at: Option<i64>,
    pub pinned: bool,
    pub online: bool,
    pub last_seen_at: Option<i64>,
    pub unread: i64,
}

#[derive(Debug, Clone)]
pub struct PresenceWatcher {
    pub owner_account_id: String,
    pub conversation_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredMessage {
    pub id: String,
    pub conversation_id: String,
    pub author: String,
    pub created_at: i64,
    pub stack_id: String,
    pub message_json: String,
}

#[derive(Debug, Clone)]
pub enum StoredEvent {
    Message {
        account_id: String,
        cursor: i64,
        message: StoredMessage,
    },
    ReadReceipt {
        account_id: String,
        cursor: i64,
        message_id: String,
        read_at: i64,
    },
    DeliveryReceipt {
        account_id: String,
        cursor: i64,
        message_id: String,
        delivered_at: i64,
    },
}

impl StoredEvent {
    pub fn account_id(&self) -> &str {
        match self {
            Self::Message { account_id, .. }
            | Self::ReadReceipt { account_id, .. }
            | Self::DeliveryReceipt { account_id, .. } => account_id,
        }
    }

    pub fn cursor(&self) -> i64 {
        match self {
            Self::Message { cursor, .. }
            | Self::ReadReceipt { cursor, .. }
            | Self::DeliveryReceipt { cursor, .. } => *cursor,
        }
    }
}

#[derive(Debug, Clone)]
pub struct StoredDeviceKey {
    pub device_id: String,
    pub key_id: String,
    pub encryption_public_key: String,
    pub signing_public_key: String,
    pub created_at: i64,
}

#[derive(Debug, Clone)]
pub struct StoredAccountKey {
    pub key_id: String,
    pub encryption_public_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredReadReceipt {
    pub message_id: String,
    pub read_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredDeliveryReceipt {
    pub message_id: String,
    pub delivered_at: i64,
}

pub struct SyncSnapshot {
    pub cursor: i64,
    pub conversations: Vec<StoredConversation>,
    pub folders: Vec<StoredFolder>,
    pub messages: Vec<StoredMessage>,
    pub read_receipts: Vec<StoredReadReceipt>,
    pub delivery_receipts: Vec<StoredDeliveryReceipt>,
}

fn message_id_from_json(message_json: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(message_json)
        .ok()?
        .get("message_id")?
        .as_str()
        .map(str::to_owned)
}

fn message_stack_id(conversation_id: &str, author: &str, created_at: i64) -> String {
    format!(
        "{conversation_id}:{author}:{}",
        created_at.div_euclid(60_000)
    )
}

pub struct SqliteStorage {
    connection: Connection,
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_millis() as i64
}

fn decode_sqlite_event(
    account_id: &str,
    cursor: i64,
    kind: &str,
    payload_json: &str,
) -> SqlResult<StoredEvent> {
    let invalid =
        |error: serde_json::Error| rusqlite::Error::ToSqlConversionFailure(Box::new(error));
    match kind {
        "message" => Ok(StoredEvent::Message {
            account_id: account_id.to_owned(),
            cursor,
            message: serde_json::from_str(payload_json).map_err(invalid)?,
        }),
        "readReceipt" => {
            let payload: StoredReadReceipt = serde_json::from_str(payload_json).map_err(invalid)?;
            Ok(StoredEvent::ReadReceipt {
                account_id: account_id.to_owned(),
                cursor,
                message_id: payload.message_id,
                read_at: payload.read_at,
            })
        }
        "deliveryReceipt" => {
            let payload: StoredDeliveryReceipt =
                serde_json::from_str(payload_json).map_err(invalid)?;
            Ok(StoredEvent::DeliveryReceipt {
                account_id: account_id.to_owned(),
                cursor,
                message_id: payload.message_id,
                delivered_at: payload.delivered_at,
            })
        }
        _ => Err(rusqlite::Error::InvalidQuery),
    }
}

fn append_sqlite_event(
    transaction: &Transaction<'_>,
    account_id: &str,
    kind: &str,
    source_id: &str,
    payload_json: &str,
    created_at: i64,
) -> SqlResult<i64> {
    if let Some(cursor) = transaction
        .query_row(
            "SELECT cursor FROM realtime_events WHERE account_id = ?1 AND kind = ?2 AND source_id = ?3",
            params![account_id, kind, source_id],
            |row| row.get(0),
        )
        .optional()?
    {
        return Ok(cursor);
    }
    transaction.execute(
        "INSERT OR IGNORE INTO realtime_event_cursors (account_id, cursor) VALUES (?1, 0)",
        params![account_id],
    )?;
    transaction.execute(
        "UPDATE realtime_event_cursors SET cursor = cursor + 1 WHERE account_id = ?1",
        params![account_id],
    )?;
    let cursor = transaction.query_row(
        "SELECT cursor FROM realtime_event_cursors WHERE account_id = ?1",
        params![account_id],
        |row| row.get(0),
    )?;
    transaction.execute(
        "INSERT INTO realtime_events (account_id, cursor, kind, source_id, payload_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![account_id, cursor, kind, source_id, payload_json, created_at],
    )?;
    Ok(cursor)
}

fn append_sqlite_message_event(
    transaction: &Transaction<'_>,
    account_id: &str,
    message: &StoredMessage,
) -> SqlResult<i64> {
    let payload_json = serde_json::to_string(message)
        .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
    append_sqlite_event(
        transaction,
        account_id,
        "message",
        &message.id,
        &payload_json,
        message.created_at,
    )
}

fn append_sqlite_receipt_event(
    transaction: &Transaction<'_>,
    account_id: &str,
    kind: &str,
    message_id: &str,
    value: i64,
    created_at: i64,
) -> SqlResult<i64> {
    let payload_json = match kind {
        "readReceipt" => serde_json::to_string(&StoredReadReceipt {
            message_id: message_id.to_owned(),
            read_at: value,
        }),
        "deliveryReceipt" => serde_json::to_string(&StoredDeliveryReceipt {
            message_id: message_id.to_owned(),
            delivered_at: value,
        }),
        _ => return Err(rusqlite::Error::InvalidQuery),
    }
    .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
    append_sqlite_event(
        transaction,
        account_id,
        kind,
        &format!("{message_id}:{value}"),
        &payload_json,
        created_at,
    )
}

fn backfill_sqlite_events(connection: &mut Connection) -> SqlResult<()> {
    let account_ids = {
        let mut statement = connection.prepare("SELECT id FROM accounts")?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<SqlResult<Vec<_>>>()?;
        rows
    };
    for account_id in account_ids {
        let transaction = connection.transaction()?;
        let mut cursor = transaction.query_row(
            "SELECT COALESCE(MAX(cursor), 0) FROM realtime_events WHERE account_id = ?1",
            params![account_id],
            |row| row.get::<_, i64>(0),
        )?;
        let messages = {
            let mut statement = transaction.prepare(
                "SELECT seq, id, conversation_id, author, created_at, stack_id, message_json
                 FROM messages WHERE owner_account_id = ?1 AND message_json <> '' ORDER BY seq ASC",
            )?;
            let rows = statement
                .query_map(params![account_id], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        StoredMessage {
                            id: row.get(1)?,
                            conversation_id: row.get(2)?,
                            author: row.get(3)?,
                            created_at: row.get(4)?,
                            stack_id: row.get(5)?,
                            message_json: row.get(6)?,
                        },
                    ))
                })?
                .collect::<SqlResult<Vec<_>>>()?;
            rows
        };
        for (seq, message) in messages {
            let exists = transaction
                .query_row(
                    "SELECT 1 FROM realtime_events WHERE account_id = ?1 AND kind = 'message' AND source_id = ?2",
                    params![account_id, message.id],
                    |_| Ok(()),
                )
                .optional()?
                .is_some();
            if exists {
                continue;
            }
            cursor = cursor.saturating_add(1).max(seq);
            let payload_json = serde_json::to_string(&message)
                .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
            transaction.execute(
                "INSERT INTO realtime_events (account_id, cursor, kind, source_id, payload_json, created_at) VALUES (?1, ?2, 'message', ?3, ?4, ?5)",
                params![account_id, cursor, message.id, payload_json, message.created_at],
            )?;
        }
        transaction.execute(
            "INSERT INTO realtime_event_cursors (account_id, cursor) VALUES (?1, ?2)
             ON CONFLICT(account_id) DO UPDATE SET cursor = MAX(cursor, excluded.cursor)",
            params![account_id, cursor],
        )?;
        let receipts = {
            let mut statement = transaction.prepare(
                "SELECT receipts.message_id, MAX(receipts.read_at)
                 FROM message_read_receipts receipts
                 JOIN messages own_messages ON own_messages.id = receipts.message_id
                 WHERE own_messages.owner_account_id = ?1 AND own_messages.author = 'me'
                 GROUP BY receipts.message_id",
            )?;
            let rows = statement
                .query_map(params![account_id], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
                })?
                .collect::<SqlResult<Vec<_>>>()?;
            rows
        };
        for (message_id, read_at) in receipts {
            append_sqlite_receipt_event(
                &transaction,
                &account_id,
                "readReceipt",
                &message_id,
                read_at,
                read_at,
            )?;
        }
        let receipts = {
            let mut statement = transaction.prepare(
                "SELECT receipts.message_id, MAX(receipts.delivered_at)
                 FROM message_delivery_receipts receipts
                 JOIN messages own_messages ON own_messages.id = receipts.message_id
                 WHERE own_messages.owner_account_id = ?1 AND own_messages.author = 'me'
                 GROUP BY receipts.message_id",
            )?;
            let rows = statement
                .query_map(params![account_id], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
                })?
                .collect::<SqlResult<Vec<_>>>()?;
            rows
        };
        for (message_id, delivered_at) in receipts {
            append_sqlite_receipt_event(
                &transaction,
                &account_id,
                "deliveryReceipt",
                &message_id,
                delivered_at,
                delivered_at,
            )?;
        }
        transaction.commit()?;
    }
    Ok(())
}

impl SqliteStorage {
    pub fn open(path: &str) -> SqlResult<Self> {
        let path = path
            .strip_prefix("sqlite://")
            .or_else(|| path.strip_prefix("sqlite:"))
            .unwrap_or(path);
        if let Some(parent) = Path::new(path).parent() {
            if !parent.as_os_str().is_empty() {
                fs::create_dir_all(parent)
                    .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
            }
        }

        let mut connection = Connection::open(path)?;
        connection.busy_timeout(Duration::from_secs(5))?;
        connection.execute_batch(
            "PRAGMA foreign_keys = ON;
             CREATE TABLE IF NOT EXISTS schema_migrations (
                 version INTEGER PRIMARY KEY
             );
             CREATE TABLE IF NOT EXISTS server_metadata (
                 key TEXT PRIMARY KEY,
                 value TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS accounts (
                 id TEXT PRIMARY KEY,
                 name TEXT NOT NULL,
                 handle TEXT NOT NULL UNIQUE,
                 password_hash TEXT NOT NULL,
                 created_at INTEGER NOT NULL,
                 last_seen_at INTEGER
             );
             CREATE TABLE IF NOT EXISTS sessions (
                 token TEXT PRIMARY KEY,
                 account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
                 created_at INTEGER NOT NULL,
                 expires_at INTEGER NOT NULL DEFAULT 0,
                 session_id TEXT,
                 device_id TEXT,
                 platform TEXT NOT NULL DEFAULT 'unknown',
                 device_name TEXT,
                 app_version TEXT,
                 last_seen_at INTEGER
             );
             CREATE TABLE IF NOT EXISTS account_settings (
                 account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
                 value_json TEXT NOT NULL,
                 updated_at INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS account_folders (
                 account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
                 folders_json TEXT NOT NULL,
                 updated_at INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS devices (
                 owner_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
                 device_id TEXT NOT NULL,
                 platform TEXT NOT NULL DEFAULT 'unknown',
                 name TEXT,
                 app_version TEXT,
                 created_at INTEGER NOT NULL,
                 last_seen_at INTEGER,
                 revoked_at INTEGER,
                 PRIMARY KEY(owner_account_id, device_id)
             );
             CREATE TABLE IF NOT EXISTS conversations (
                 id TEXT PRIMARY KEY,
                 owner_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
                 name TEXT NOT NULL,
                 handle TEXT,
                 avatar TEXT NOT NULL,
                 subtitle TEXT,
                 can_write INTEGER NOT NULL DEFAULT 1,
                 last_message TEXT NOT NULL DEFAULT '',
                 last_message_at INTEGER,
                 pinned INTEGER NOT NULL DEFAULT 0,
                 online INTEGER NOT NULL DEFAULT 0,
                 sort_order INTEGER NOT NULL DEFAULT 0,
                 created_at INTEGER NOT NULL,
                 updated_at INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS conversations_owner_order ON conversations(owner_account_id, pinned DESC, sort_order ASC, created_at ASC);
             CREATE UNIQUE INDEX IF NOT EXISTS conversations_owner_handle ON conversations(owner_account_id, handle) WHERE handle IS NOT NULL;
             CREATE TABLE IF NOT EXISTS messages (
                 seq INTEGER PRIMARY KEY AUTOINCREMENT,
                 id TEXT NOT NULL UNIQUE,
                 owner_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
                 conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                 author TEXT NOT NULL CHECK(author IN ('me', 'them')),
                 text TEXT NOT NULL DEFAULT '',
                 message_json TEXT NOT NULL DEFAULT '',
                 created_at INTEGER NOT NULL,
                 stack_id TEXT NOT NULL DEFAULT '',
                 client_message_id TEXT NOT NULL,
                 UNIQUE(owner_account_id, client_message_id)
             );
             CREATE INDEX IF NOT EXISTS messages_owner_cursor ON messages(owner_account_id, seq ASC);
             CREATE TABLE IF NOT EXISTS media_objects (
                 id TEXT PRIMARY KEY,
                 owner_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
                 recipient_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
                 conversation_id TEXT NOT NULL,
                 ciphertext BLOB NOT NULL,
                 byte_size INTEGER NOT NULL,
                 created_at INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS media_objects_recipient ON media_objects(recipient_account_id, created_at ASC);
             CREATE TABLE IF NOT EXISTS realtime_event_cursors (
                 account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
                 cursor INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS realtime_events (
                 account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
                 cursor INTEGER NOT NULL,
                 kind TEXT NOT NULL CHECK(kind IN ('message', 'readReceipt', 'deliveryReceipt')),
                 source_id TEXT NOT NULL,
                 payload_json TEXT NOT NULL,
                 created_at INTEGER NOT NULL,
                 PRIMARY KEY(account_id, cursor),
                 UNIQUE(account_id, kind, source_id)
             );
             CREATE INDEX IF NOT EXISTS realtime_events_account_cursor ON realtime_events(account_id, cursor ASC);
             CREATE TABLE IF NOT EXISTS conversation_reads (
                 owner_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
                 conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                 read_at INTEGER NOT NULL,
                 PRIMARY KEY(owner_account_id, conversation_id)
             );
             CREATE TABLE IF NOT EXISTS message_read_receipts (
                 message_id TEXT NOT NULL,
                 reader_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
                 read_at INTEGER NOT NULL,
                 PRIMARY KEY(message_id, reader_account_id)
             );
             CREATE TABLE IF NOT EXISTS message_delivery_receipts (
                 message_id TEXT NOT NULL,
                 recipient_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
                 delivered_at INTEGER NOT NULL,
                 PRIMARY KEY(message_id, recipient_account_id)
             );
             CREATE TABLE IF NOT EXISTS device_keys (
                 owner_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
                 device_id TEXT NOT NULL,
                 key_id TEXT NOT NULL,
                 encryption_public_key TEXT NOT NULL,
                 signing_public_key TEXT NOT NULL,
                 created_at INTEGER NOT NULL,
                 updated_at INTEGER NOT NULL,
                 PRIMARY KEY(owner_account_id, device_id),
                 UNIQUE(owner_account_id, key_id)
             );
             CREATE TABLE IF NOT EXISTS push_tokens (
                 owner_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
                 device_id TEXT NOT NULL,
                 token TEXT NOT NULL UNIQUE,
                 platform TEXT NOT NULL CHECK(platform IN ('android', 'ios')),
                 created_at INTEGER NOT NULL,
                 updated_at INTEGER NOT NULL,
                 PRIMARY KEY(owner_account_id, device_id)
             );
             CREATE INDEX IF NOT EXISTS push_tokens_owner ON push_tokens(owner_account_id);
             CREATE TABLE IF NOT EXISTS account_keys (
                 owner_account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
                 key_id TEXT NOT NULL UNIQUE,
                 encryption_public_key TEXT NOT NULL,
                 created_at INTEGER NOT NULL,
                 updated_at INTEGER NOT NULL
             );
             ",
        )?;
        let has_last_seen_column = connection.query_row(
            "SELECT COUNT(*) FROM pragma_table_info('accounts') WHERE name = 'last_seen_at'",
            [],
            |row| row.get::<_, i64>(0),
        )?;
        if has_last_seen_column == 0 {
            connection.execute("ALTER TABLE accounts ADD COLUMN last_seen_at INTEGER", [])?;
        }
        let has_session_expiry_column = connection.query_row(
            "SELECT COUNT(*) FROM pragma_table_info('sessions') WHERE name = 'expires_at'",
            [],
            |row| row.get::<_, i64>(0),
        )?;
        if has_session_expiry_column == 0 {
            connection.execute(
                "ALTER TABLE sessions ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 0",
                [],
            )?;
        }
        for (column, definition) in [
            ("session_id", "TEXT"),
            ("device_id", "TEXT"),
            ("platform", "TEXT NOT NULL DEFAULT 'unknown'"),
            ("device_name", "TEXT"),
            ("app_version", "TEXT"),
            ("last_seen_at", "INTEGER"),
        ] {
            let exists = connection.query_row(
                "SELECT COUNT(*) FROM pragma_table_info('sessions') WHERE name = ?1",
                params![column],
                |row| row.get::<_, i64>(0),
            )?;
            if exists == 0 {
                connection.execute(
                    &format!("ALTER TABLE sessions ADD COLUMN {column} {definition}"),
                    [],
                )?;
            }
        }
        connection.execute("CREATE UNIQUE INDEX IF NOT EXISTS sessions_session_id ON sessions(session_id) WHERE session_id IS NOT NULL", [])?;
        connection.execute("CREATE TABLE IF NOT EXISTS account_settings (account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL)", [])?;
        connection.execute("CREATE TABLE IF NOT EXISTS account_folders (account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE, folders_json TEXT NOT NULL, updated_at INTEGER NOT NULL)", [])?;
        connection.execute("CREATE TABLE IF NOT EXISTS devices (owner_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, device_id TEXT NOT NULL, platform TEXT NOT NULL DEFAULT 'unknown', name TEXT, app_version TEXT, created_at INTEGER NOT NULL, last_seen_at INTEGER, revoked_at INTEGER, PRIMARY KEY(owner_account_id, device_id))", [])?;
        connection.execute(
            "UPDATE sessions SET expires_at = created_at + ?1 WHERE expires_at <= 0",
            params![SESSION_TTL_MS],
        )?;
        let historical_message_column = concat!("env", "elope_json");
        let has_historical_message_column = connection.query_row(
            "SELECT COUNT(*) FROM pragma_table_info('messages') WHERE name = ?1",
            params![historical_message_column],
            |row| row.get::<_, i64>(0),
        )?;
        let has_encrypted_message_column = connection.query_row(
            "SELECT COUNT(*) FROM pragma_table_info('messages') WHERE name = 'message_json'",
            [],
            |row| row.get::<_, i64>(0),
        )?;
        let renamed_message_column = has_historical_message_column > 0;
        if renamed_message_column && has_encrypted_message_column > 0 {
            connection.execute(
                &format!(
                    "UPDATE messages SET message_json = CASE WHEN message_json = '' THEN \"{historical_message_column}\" ELSE message_json END"
                ),
                [],
            )?;
            connection.execute(
                &format!("ALTER TABLE messages DROP COLUMN \"{historical_message_column}\""),
                [],
            )?;
        } else if renamed_message_column {
            connection.execute(
                &format!(
                    "ALTER TABLE messages RENAME COLUMN \"{historical_message_column}\" TO message_json"
                ),
                [],
            )?;
        } else if has_encrypted_message_column == 0 {
            connection.execute(
                "ALTER TABLE messages ADD COLUMN message_json TEXT NOT NULL DEFAULT ''",
                [],
            )?;
        }
        let has_stack_column = connection.query_row(
            "SELECT COUNT(*) FROM pragma_table_info('messages') WHERE name = 'stack_id'",
            [],
            |row| row.get::<_, i64>(0),
        )?;
        if has_stack_column == 0 {
            connection.execute(
                "ALTER TABLE messages ADD COLUMN stack_id TEXT NOT NULL DEFAULT ''",
                [],
            )?;
        }
        connection.execute(
            "UPDATE messages SET stack_id = conversation_id || ':' || author || ':' || CAST(created_at / 60000 AS TEXT) WHERE stack_id = ''",
            [],
        )?;
        connection.execute("UPDATE messages SET text = '' WHERE message_json = ''", [])?;
        connection.execute("UPDATE conversations SET last_message = ''", [])?;
        connection.execute(
            "CREATE TABLE IF NOT EXISTS account_keys (owner_account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE, key_id TEXT NOT NULL UNIQUE, encryption_public_key TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
            [],
        )?;
        connection.execute(
            "INSERT OR IGNORE INTO schema_migrations (version) VALUES (1)",
            [],
        )?;
        connection.execute(
            "INSERT OR IGNORE INTO schema_migrations (version) VALUES (2)",
            [],
        )?;
        let has_event_migration = connection.query_row(
            "SELECT COUNT(*) FROM schema_migrations WHERE version = 3",
            [],
            |row| row.get::<_, i64>(0),
        )?;
        if renamed_message_column {
            connection.execute("DELETE FROM realtime_events WHERE kind = 'message'", [])?;
        }
        if has_event_migration == 0 {
            backfill_sqlite_events(&mut connection)?;
            connection.execute(
                "INSERT OR IGNORE INTO schema_migrations (version) VALUES (3)",
                [],
            )?;
        } else if renamed_message_column {
            backfill_sqlite_events(&mut connection)?;
        }
        let account_ids = {
            let mut statement = connection.prepare("SELECT id FROM accounts")?;
            let rows = statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<SqlResult<Vec<_>>>()?;
            rows
        };
        if !account_ids.is_empty() {
            let transaction = connection.transaction()?;
            let now = now_ms();
            for account_id in account_ids {
                ensure_system_conversations(&transaction, &account_id, now)?;
            }
            transaction.commit()?;
        }
        Ok(Self { connection })
    }

    pub fn create_account(&mut self, account: &StoredAccount, created_at: i64) -> SqlResult<bool> {
        let transaction = self.connection.transaction()?;
        let inserted = transaction.execute(
            "INSERT OR IGNORE INTO accounts (id, name, handle, password_hash, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![account.id, account.name, account.handle, account.password_hash, created_at],
        )?;
        if inserted == 0 {
            return Ok(false);
        }
        transaction.execute(
            "INSERT OR IGNORE INTO realtime_event_cursors (account_id, cursor) VALUES (?1, 0)",
            params![account.id],
        )?;
        ensure_system_conversations(&transaction, &account.id, created_at)?;
        transaction.commit()?;
        Ok(true)
    }

    pub fn ensure_server_id(&mut self) -> SqlResult<String> {
        if let Some(id) = self
            .connection
            .query_row(
                "SELECT value FROM server_metadata WHERE key = 'server_id'",
                [],
                |row| row.get(0),
            )
            .optional()?
        {
            return Ok(id);
        }
        let id = new_server_id();
        self.connection.execute(
            "INSERT INTO server_metadata (key, value) VALUES ('server_id', ?1)",
            params![id],
        )?;
        Ok(id)
    }

    pub fn canonicalize_local_conversations(&mut self, public_server: &str) -> SqlResult<()> {
        let canonical_server = canonical_server(public_server);
        let mut statement = self.connection.prepare(
            "SELECT id, owner_account_id, handle FROM conversations WHERE handle IS NOT NULL AND handle NOT IN ('official', 'favorites')",
        )?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?
            .collect::<SqlResult<Vec<_>>>()?;
        drop(statement);

        let mut aliases: HashMap<(String, String), Vec<(String, String)>> = HashMap::new();
        for (id, owner_id, handle) in rows {
            let Some((peer_handle, peer_server)) = handle.rsplit_once('@') else {
                continue;
            };
            if same_local_server(public_server, peer_server) {
                aliases
                    .entry((owner_id, format!("{peer_handle}@{canonical_server}")))
                    .or_default()
                    .push((id, handle));
            }
        }

        let transaction = self.connection.transaction()?;
        for ((owner_id, canonical_handle), rows) in aliases {
            let keeper = transaction
                .query_row(
                    "SELECT id FROM conversations WHERE owner_account_id = ?1 AND handle = ?2",
                    params![owner_id, canonical_handle],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;
            let keeper = if let Some(id) = keeper {
                id
            } else {
                let id = rows[0].0.clone();
                transaction.execute(
                    "UPDATE conversations SET handle = ?1 WHERE owner_account_id = ?2 AND id = ?3",
                    params![canonical_handle, owner_id, id],
                )?;
                id
            };

            for (source, _) in rows {
                if source == keeper {
                    continue;
                }
                let source_state = transaction.query_row(
                    "SELECT last_message, last_message_at, pinned, sort_order, updated_at FROM conversations WHERE owner_account_id = ?1 AND id = ?2",
                    params![owner_id, source],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<i64>>(1)?, row.get::<_, i64>(2)?, row.get::<_, i64>(3)?, row.get::<_, i64>(4)?)),
                )?;
                let target_state = transaction.query_row(
                    "SELECT last_message, last_message_at, pinned, sort_order, updated_at FROM conversations WHERE owner_account_id = ?1 AND id = ?2",
                    params![owner_id, keeper],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<i64>>(1)?, row.get::<_, i64>(2)?, row.get::<_, i64>(3)?, row.get::<_, i64>(4)?)),
                )?;
                if source_state.4 > target_state.4 {
                    transaction.execute(
                        "UPDATE conversations SET last_message = ?1, last_message_at = ?2, updated_at = ?3 WHERE owner_account_id = ?4 AND id = ?5",
                        params![source_state.0, source_state.1, source_state.4, owner_id, keeper],
                    )?;
                }
                transaction.execute(
                    "UPDATE conversations SET pinned = MAX(pinned, ?1), sort_order = MIN(sort_order, ?2) WHERE owner_account_id = ?3 AND id = ?4",
                    params![source_state.2, source_state.3, owner_id, keeper],
                )?;
                transaction.execute(
                    "UPDATE messages SET conversation_id = ?1 WHERE owner_account_id = ?2 AND conversation_id = ?3",
                    params![keeper, owner_id, source],
                )?;
                let source_read = transaction
                    .query_row(
                        "SELECT read_at FROM conversation_reads WHERE owner_account_id = ?1 AND conversation_id = ?2",
                        params![owner_id, source],
                        |row| row.get::<_, i64>(0),
                    )
                    .optional()?;
                let target_read = transaction
                    .query_row(
                        "SELECT read_at FROM conversation_reads WHERE owner_account_id = ?1 AND conversation_id = ?2",
                        params![owner_id, keeper],
                        |row| row.get::<_, i64>(0),
                    )
                    .optional()?;
                if source_read.is_some() || target_read.is_some() {
                    let read_at = source_read
                        .into_iter()
                        .chain(target_read)
                        .max()
                        .unwrap_or(0);
                    transaction.execute(
                        "DELETE FROM conversation_reads WHERE owner_account_id = ?1 AND conversation_id IN (?2, ?3)",
                        params![owner_id, source, keeper],
                    )?;
                    transaction.execute(
                        "INSERT INTO conversation_reads (owner_account_id, conversation_id, read_at) VALUES (?1, ?2, ?3)",
                        params![owner_id, keeper, read_at],
                    )?;
                }
                transaction.execute(
                    "DELETE FROM conversations WHERE owner_account_id = ?1 AND id = ?2",
                    params![owner_id, source],
                )?;
            }
        }
        transaction.commit()
    }

    pub fn account_by_handle(&self, handle: &str) -> SqlResult<Option<StoredAccount>> {
        self.connection
            .query_row(
                "SELECT id, name, handle, password_hash FROM accounts WHERE handle = ?1",
                params![handle],
                |row| {
                    Ok(StoredAccount {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        handle: row.get(2)?,
                        password_hash: row.get(3)?,
                    })
                },
            )
            .optional()
    }

    pub fn account_by_id(&self, account_id: &str) -> SqlResult<Option<StoredAccount>> {
        self.connection
            .query_row(
                "SELECT id, name, handle, password_hash FROM accounts WHERE id = ?1",
                params![account_id],
                |row| {
                    Ok(StoredAccount {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        handle: row.get(2)?,
                        password_hash: row.get(3)?,
                    })
                },
            )
            .optional()
    }

    pub fn account_by_handle_prefix(&self, prefix: &str) -> SqlResult<Option<StoredAccount>> {
        self.connection
            .query_row(
                "SELECT id, name, handle, password_hash FROM accounts WHERE handle LIKE ?1 || '%' ORDER BY handle LIMIT 1",
                params![prefix],
                |row| {
                    Ok(StoredAccount {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        handle: row.get(2)?,
                        password_hash: row.get(3)?,
                    })
                },
            )
            .optional()
    }

    pub fn account_settings(&self, account_id: &str) -> SqlResult<AccountSettings> {
        let raw = self
            .connection
            .query_row(
                "SELECT value_json FROM account_settings WHERE account_id = ?1",
                params![account_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        Ok(raw
            .and_then(|value| serde_json::from_str(&value).ok())
            .unwrap_or_default())
    }

    pub fn update_account_settings(
        &mut self,
        account_id: &str,
        settings: &AccountSettings,
        updated_at: i64,
    ) -> SqlResult<()> {
        let value_json = serde_json::to_string(settings)
            .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
        self.connection.execute(
            "INSERT INTO account_settings (account_id, value_json, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(account_id) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
            params![account_id, value_json, updated_at],
        )?;
        Ok(())
    }

    pub fn account_folders(&self, account_id: &str) -> SqlResult<Vec<StoredFolder>> {
        let raw = self
            .connection
            .query_row(
                "SELECT folders_json FROM account_folders WHERE account_id = ?1",
                params![account_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        Ok(raw
            .and_then(|value| serde_json::from_str(&value).ok())
            .unwrap_or_default())
    }

    pub fn update_account_folders(
        &mut self,
        account_id: &str,
        folders: &[StoredFolder],
        updated_at: i64,
    ) -> SqlResult<()> {
        let folders_json = serde_json::to_string(folders)
            .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
        self.connection.execute(
            "INSERT INTO account_folders (account_id, folders_json, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(account_id) DO UPDATE SET folders_json = excluded.folders_json, updated_at = excluded.updated_at",
            params![account_id, folders_json, updated_at],
        )?;
        Ok(())
    }

    pub fn update_account_name(&mut self, account_id: &str, name: &str) -> SqlResult<bool> {
        Ok(self.connection.execute(
            "UPDATE accounts SET name = ?1 WHERE id = ?2",
            params![name, account_id],
        )? > 0)
    }

    pub fn change_password(&mut self, account_id: &str, password_hash: &str) -> SqlResult<bool> {
        Ok(self.connection.execute(
            "UPDATE accounts SET password_hash = ?1 WHERE id = ?2",
            params![password_hash, account_id],
        )? > 0)
    }

    #[cfg(test)]
    pub fn store_session(
        &mut self,
        token: &str,
        account_id: &str,
        created_at: i64,
    ) -> SqlResult<()> {
        self.store_session_with_metadata(token, account_id, created_at, None, None, None, None)?;
        Ok(())
    }

    pub fn store_session_with_metadata(
        &mut self,
        token: &str,
        account_id: &str,
        created_at: i64,
        device_id: Option<&str>,
        platform: Option<&str>,
        device_name: Option<&str>,
        app_version: Option<&str>,
    ) -> SqlResult<String> {
        let session_id = legacy_session_id(token);
        self.connection.execute(
            "INSERT OR REPLACE INTO sessions (token, account_id, created_at, expires_at, session_id, device_id, platform, device_name, app_version, last_seen_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, COALESCE(?7, 'unknown'), ?8, ?9, ?3)",
            params![token, account_id, created_at, created_at.saturating_add(SESSION_TTL_MS), session_id, device_id, platform, device_name, app_version],
        )?;
        Ok(session_id)
    }

    pub fn account_id_for_session(&self, token: &str, now: i64) -> SqlResult<Option<String>> {
        self.connection
            .query_row(
                "SELECT account_id FROM sessions WHERE token = ?1 AND expires_at > ?2",
                params![token, now],
                |row| row.get(0),
            )
            .optional()
    }

    pub fn revoke_session(&mut self, token: &str) -> SqlResult<bool> {
        Ok(self
            .connection
            .execute("DELETE FROM sessions WHERE token = ?1", params![token])?
            > 0)
    }

    pub fn list_sessions(
        &mut self,
        account_id: &str,
        current_token: &str,
        now: i64,
    ) -> SqlResult<Vec<StoredSession>> {
        let rows = {
            let mut statement = self.connection.prepare("SELECT token, session_id, device_id, platform, device_name, app_version, created_at, expires_at, last_seen_at FROM sessions WHERE account_id = ?1 AND expires_at > ?2 ORDER BY COALESCE(last_seen_at, created_at) DESC")?;
            let mapped = statement.query_map(params![account_id, now], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, i64>(7)?,
                    row.get::<_, Option<i64>>(8)?,
                ))
            })?;
            mapped.collect::<SqlResult<Vec<_>>>()?
        };
        let mut result = Vec::with_capacity(rows.len());
        for (
            token,
            id,
            device_id,
            platform,
            device_name,
            app_version,
            created_at,
            expires_at,
            last_seen_at,
        ) in rows
        {
            let id = id
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| legacy_session_id(&token));
            self.connection.execute("UPDATE sessions SET session_id = ?1 WHERE token = ?2 AND (session_id IS NULL OR session_id = '')", params![id, token])?;
            result.push(StoredSession {
                id,
                device_id,
                platform,
                device_name,
                app_version,
                created_at,
                expires_at,
                last_seen_at,
                current: token == current_token,
            });
        }
        Ok(result)
    }

    pub fn revoke_session_by_id(&mut self, account_id: &str, session_id: &str) -> SqlResult<bool> {
        Ok(self.connection.execute(
            "DELETE FROM sessions WHERE account_id = ?1 AND session_id = ?2",
            params![account_id, session_id],
        )? > 0)
    }

    pub fn revoke_other_sessions(
        &mut self,
        account_id: &str,
        current_token: &str,
    ) -> SqlResult<u64> {
        Ok(self.connection.execute(
            "DELETE FROM sessions WHERE account_id = ?1 AND token <> ?2",
            params![account_id, current_token],
        )? as u64)
    }

    pub fn bind_session_device(
        &mut self,
        account_id: &str,
        token: &str,
        device_id: &str,
    ) -> SqlResult<bool> {
        Ok(self.connection.execute(
            "UPDATE sessions SET device_id = ?1 WHERE account_id = ?2 AND token = ?3 AND (device_id IS NULL OR device_id = ?1)",
            params![device_id, account_id, token],
        )? > 0)
    }

    pub fn update_session_metadata(
        &mut self,
        account_id: &str,
        token: &str,
        platform: Option<&str>,
        device_name: Option<&str>,
        app_version: Option<&str>,
        now: i64,
    ) -> SqlResult<bool> {
        Ok(self.connection.execute(
            "UPDATE sessions SET platform = COALESCE(NULLIF(?3, ''), platform), device_name = COALESCE(NULLIF(?4, ''), device_name), app_version = COALESCE(NULLIF(?5, ''), app_version), last_seen_at = ?6 WHERE account_id = ?1 AND token = ?2 AND expires_at > ?6",
            params![account_id, token, platform, device_name, app_version, now],
        )? > 0)
    }

    pub fn upsert_device(
        &mut self,
        account_id: &str,
        device_id: &str,
        platform: &str,
        name: Option<&str>,
        app_version: Option<&str>,
        now: i64,
    ) -> SqlResult<()> {
        self.connection.execute("INSERT INTO devices (owner_account_id, device_id, platform, name, app_version, created_at, last_seen_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6) ON CONFLICT(owner_account_id, device_id) DO UPDATE SET platform = COALESCE(NULLIF(excluded.platform, 'unknown'), devices.platform), name = COALESCE(excluded.name, devices.name), app_version = COALESCE(excluded.app_version, devices.app_version), last_seen_at = excluded.last_seen_at, revoked_at = NULL", params![account_id, device_id, platform, name, app_version, now])?;
        Ok(())
    }

    pub fn list_devices(&self, account_id: &str) -> SqlResult<Vec<StoredDevice>> {
        let mut statement = self.connection.prepare("SELECT device_id, platform, name, app_version, created_at, last_seen_at, revoked_at FROM devices WHERE owner_account_id = ?1 ORDER BY COALESCE(last_seen_at, created_at) DESC")?;
        let devices = statement
            .query_map(params![account_id], |row| {
                Ok(StoredDevice {
                    device_id: row.get(0)?,
                    platform: row.get(1)?,
                    name: row.get(2)?,
                    app_version: row.get(3)?,
                    created_at: row.get(4)?,
                    last_seen_at: row.get(5)?,
                    revoked_at: row.get(6)?,
                })
            })?
            .collect();
        devices
    }

    pub fn revoke_device(
        &mut self,
        account_id: &str,
        device_id: &str,
        now: i64,
    ) -> SqlResult<bool> {
        let transaction = self.connection.transaction()?;
        let changed = transaction.execute("UPDATE devices SET revoked_at = ?1 WHERE owner_account_id = ?2 AND device_id = ?3 AND revoked_at IS NULL", params![now, account_id, device_id])?;
        transaction.execute(
            "DELETE FROM device_keys WHERE owner_account_id = ?1 AND device_id = ?2",
            params![account_id, device_id],
        )?;
        transaction.execute(
            "DELETE FROM push_tokens WHERE owner_account_id = ?1 AND device_id = ?2",
            params![account_id, device_id],
        )?;
        transaction.execute(
            "DELETE FROM sessions WHERE account_id = ?1 AND device_id = ?2",
            params![account_id, device_id],
        )?;
        transaction.commit()?;
        Ok(changed > 0)
    }

    pub fn register_push_token(
        &mut self,
        account_id: &str,
        device_id: &str,
        token: &str,
        platform: &str,
        updated_at: i64,
    ) -> SqlResult<()> {
        self.connection.execute(
            "DELETE FROM push_tokens WHERE token = ?1 AND NOT (owner_account_id = ?2 AND device_id = ?3)",
            params![token, account_id, device_id],
        )?;
        self.connection.execute(
            "INSERT INTO push_tokens (owner_account_id, device_id, token, platform, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)
             ON CONFLICT(owner_account_id, device_id) DO UPDATE SET token = excluded.token, platform = excluded.platform, updated_at = excluded.updated_at",
            params![account_id, device_id, token, platform, updated_at],
        )?;
        Ok(())
    }

    pub fn push_tokens(&self, account_id: &str) -> SqlResult<Vec<String>> {
        let mut statement = self
            .connection
            .prepare("SELECT token FROM push_tokens WHERE owner_account_id = ?1")?;
        let tokens = statement
            .query_map(params![account_id], |row| row.get(0))?
            .collect();
        tokens
    }

    pub fn touch_presence(&mut self, account_id: &str, now: i64) -> SqlResult<()> {
        self.connection.execute(
            "UPDATE accounts SET last_seen_at = ?1 WHERE id = ?2",
            params![now, account_id],
        )?;
        Ok(())
    }

    pub fn presence_watchers(
        &self,
        account_id: &str,
        local_server: &str,
    ) -> SqlResult<Vec<PresenceWatcher>> {
        let local_server = canonical_server(local_server);
        let mut statement = self.connection.prepare(
            "SELECT c.owner_account_id, c.id
             FROM conversations c
             JOIN accounts peer ON peer.id = ?1
                AND peer.handle = CASE
                    WHEN instr(c.handle, '@') > 0 THEN substr(c.handle, 1, instr(c.handle, '@') - 1)
                    ELSE c.handle
                END
                AND substr(c.handle, instr(c.handle, '@') + 1) = ?2
             WHERE c.owner_account_id <> ?1",
        )?;
        let watchers = statement
            .query_map(params![account_id, local_server], |row| {
                Ok(PresenceWatcher {
                    owner_account_id: row.get(0)?,
                    conversation_id: row.get(1)?,
                })
            })?
            .collect();
        watchers
    }

    pub fn cursor(&self, account_id: &str) -> SqlResult<i64> {
        self.connection.query_row(
            "SELECT COALESCE(cursor, 0) FROM realtime_event_cursors WHERE account_id = ?1",
            params![account_id],
            |row| row.get(0),
        )
    }

    #[cfg(test)]
    pub fn events_since(&self, account_id: &str, since: i64) -> SqlResult<Vec<StoredEvent>> {
        self.events_since_limited(account_id, since, i64::MAX)
    }

    fn events_since_limited(
        &self,
        account_id: &str,
        since: i64,
        limit: i64,
    ) -> SqlResult<Vec<StoredEvent>> {
        let mut statement = self.connection.prepare(
            "SELECT cursor, kind, payload_json FROM realtime_events
             WHERE account_id = ?1 AND cursor > ?2 ORDER BY cursor ASC LIMIT ?3",
        )?;
        let rows = statement
            .query_map(params![account_id, since.max(0), limit], |row| {
                decode_sqlite_event(
                    account_id,
                    row.get(0)?,
                    row.get::<_, String>(1)?.as_str(),
                    row.get::<_, String>(2)?.as_str(),
                )
            })?
            .collect::<SqlResult<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn event_for_message(
        &self,
        account_id: &str,
        message_id: &str,
    ) -> SqlResult<Option<StoredEvent>> {
        self.connection
            .query_row(
                "SELECT cursor, payload_json FROM realtime_events
                 WHERE account_id = ?1 AND kind = 'message' AND source_id = ?2",
                params![account_id, message_id],
                |row| {
                    decode_sqlite_event(
                        account_id,
                        row.get(0)?,
                        "message",
                        row.get::<_, String>(1)?.as_str(),
                    )
                },
            )
            .optional()
    }

    pub fn delivery_receipt(
        &self,
        message_id: &str,
        recipient_account_id: &str,
    ) -> SqlResult<Option<i64>> {
        self.connection
            .query_row(
                "SELECT delivered_at FROM message_delivery_receipts
                 WHERE message_id = ?1 AND recipient_account_id = ?2",
                params![message_id, recipient_account_id],
                |row| row.get(0),
            )
            .optional()
    }

    pub fn sync(
        &self,
        account_id: &str,
        since: i64,
        local_server: &str,
    ) -> SqlResult<SyncSnapshot> {
        let local_server = canonical_server(local_server);
        let mut conversations_statement = self.connection.prepare(
            "SELECT c.id, c.name, c.handle, c.avatar, c.subtitle, c.can_write, c.last_message, c.last_message_at, c.pinned, c.online,
                    peer.last_seen_at,
                    COALESCE((SELECT COUNT(DISTINCT CASE
                                          WHEN json_valid(unread_messages.message_json)
                                          THEN COALESCE(json_extract(unread_messages.message_json, '$.message_id'), unread_messages.id)
                                          ELSE unread_messages.id
                                      END)
                             FROM messages unread_messages
                              LEFT JOIN conversation_reads unread_reads
                                ON unread_reads.owner_account_id = unread_messages.owner_account_id
                               AND unread_reads.conversation_id = unread_messages.conversation_id
                              WHERE unread_messages.owner_account_id = c.owner_account_id
                                AND unread_messages.conversation_id = c.id
                                AND unread_messages.author = 'them'
                                AND unread_messages.message_json <> ''
                                AND unread_messages.created_at > COALESCE(unread_reads.read_at, 0)), 0)
             FROM conversations c
             LEFT JOIN accounts peer ON peer.handle = CASE
                 WHEN instr(c.handle, '@') > 0 THEN substr(c.handle, 1, instr(c.handle, '@') - 1)
                 ELSE c.handle
             END
             AND substr(c.handle, instr(c.handle, '@') + 1) = ?2
             WHERE c.owner_account_id = ?1
             ORDER BY c.pinned DESC, c.sort_order ASC, c.created_at ASC",
        )?;
        let conversations = conversations_statement
            .query_map(params![account_id, local_server], |row| {
                Ok(StoredConversation {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    handle: row.get(2)?,
                    avatar: row.get(3)?,
                    subtitle: row.get(4)?,
                    can_write: row.get::<_, i64>(5)? != 0,
                    last_message: row.get(6)?,
                    last_message_at: row.get(7)?,
                    pinned: row.get::<_, i64>(8)? != 0,
                    online: row.get::<_, i64>(9)? != 0,
                    last_seen_at: row.get(10)?,
                    unread: row.get(11)?,
                })
            })?
            .collect::<SqlResult<Vec<_>>>()?;

        let folders = self.account_folders(account_id)?;
        let events = self.events_since_limited(account_id, since, MAX_SYNC_EVENTS)?;
        let cursor = events
            .last()
            .map(StoredEvent::cursor)
            .unwrap_or(self.cursor(account_id)?);
        let mut messages = Vec::new();
        let mut read_receipts = Vec::new();
        let mut delivery_receipts = Vec::new();
        for event in events {
            match event {
                StoredEvent::Message { message, .. } => messages.push(message),
                StoredEvent::ReadReceipt {
                    message_id,
                    read_at,
                    ..
                } => read_receipts.push(StoredReadReceipt {
                    message_id,
                    read_at,
                }),
                StoredEvent::DeliveryReceipt {
                    message_id,
                    delivered_at,
                    ..
                } => delivery_receipts.push(StoredDeliveryReceipt {
                    message_id,
                    delivered_at,
                }),
            }
        }
        Ok(SyncSnapshot {
            cursor,
            conversations,
            folders,
            messages,
            read_receipts,
            delivery_receipts,
        })
    }

    pub fn can_write(&self, account_id: &str, conversation_id: &str) -> SqlResult<Option<bool>> {
        self.connection
            .query_row(
                "SELECT can_write FROM conversations WHERE owner_account_id = ?1 AND id = ?2",
                params![account_id, conversation_id],
                |row| Ok(row.get::<_, i64>(0)? != 0),
            )
            .optional()
    }

    pub fn store_media(
        &mut self,
        owner_account_id: &str,
        recipient_account_id: &str,
        conversation_id: &str,
        media_id: &str,
        ciphertext: &[u8],
        created_at: i64,
    ) -> SqlResult<bool> {
        let inserted = self.connection.execute(
            "INSERT OR IGNORE INTO media_objects (id, owner_account_id, recipient_account_id, conversation_id, ciphertext, byte_size, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![media_id, owner_account_id, recipient_account_id, conversation_id, ciphertext, ciphertext.len() as i64, created_at],
        )?;
        Ok(inserted > 0)
    }

    pub fn media_bytes(&self, account_id: &str, media_id: &str) -> SqlResult<Option<Vec<u8>>> {
        self.connection
            .query_row(
                "SELECT ciphertext FROM media_objects WHERE id = ?1 AND (owner_account_id = ?2 OR recipient_account_id = ?2)",
                params![media_id, account_id],
                |row| row.get(0),
            )
            .optional()
    }

    pub fn mark_conversation_read(
        &mut self,
        account_id: &str,
        conversation_id: &str,
        read_at: i64,
    ) -> SqlResult<Option<Vec<StoredEvent>>> {
        let transaction = self.connection.transaction()?;
        let exists = transaction
            .query_row(
                "SELECT 1 FROM conversations WHERE owner_account_id = ?1 AND id = ?2",
                params![account_id, conversation_id],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        if !exists {
            return Ok(None);
        }

        transaction.execute(
            "INSERT INTO conversation_reads (owner_account_id, conversation_id, read_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(owner_account_id, conversation_id) DO UPDATE SET read_at = MAX(read_at, excluded.read_at)",
            params![account_id, conversation_id, read_at],
        )?;

        let message_ids = {
            let mut statement = transaction.prepare(
                "SELECT message_json FROM messages
                 WHERE owner_account_id = ?1 AND conversation_id = ?2 AND author = 'them' AND created_at <= ?3 AND message_json <> ''",
            )?;
            let rows = statement
                .query_map(params![account_id, conversation_id, read_at], |row| {
                    row.get::<_, String>(0)
                })?
                .filter_map(|value| value.ok().and_then(|json| message_id_from_json(&json)))
                .collect::<Vec<_>>();
            let mut rows = rows;
            rows.sort_unstable();
            rows.dedup();
            rows
        };
        let mut events = Vec::new();
        for message_id in message_ids {
            let changed = transaction.execute(
                "INSERT INTO message_read_receipts (message_id, reader_account_id, read_at)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(message_id, reader_account_id) DO UPDATE SET read_at = MAX(read_at, excluded.read_at)
                 WHERE excluded.read_at > message_read_receipts.read_at",
                params![message_id, account_id, read_at],
            )?;
            if changed == 0 {
                continue;
            }
            let Some(sender_account_id) = transaction
                .query_row(
                    "SELECT owner_account_id FROM messages WHERE id = ?1 AND author = 'me' LIMIT 1",
                    params![message_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
            else {
                continue;
            };
            let cursor = append_sqlite_receipt_event(
                &transaction,
                &sender_account_id,
                "readReceipt",
                &message_id,
                read_at,
                read_at,
            )?;
            events.push(StoredEvent::ReadReceipt {
                account_id: sender_account_id,
                cursor,
                message_id,
                read_at,
            });
        }
        transaction.commit()?;
        Ok(Some(events))
    }

    pub fn create_direct_conversation(
        &mut self,
        account_id: &str,
        handle: &str,
        name: &str,
        avatar: &str,
        subtitle: Option<&str>,
        now: i64,
    ) -> SqlResult<StoredConversation> {
        let transaction = self.connection.transaction()?;
        if let Some(existing) = transaction
            .query_row(
                "SELECT id, name, handle, avatar, subtitle, can_write, last_message, last_message_at, pinned, online FROM conversations WHERE owner_account_id = ?1 AND handle = ?2",
                params![account_id, handle],
                |row| {
                    Ok(StoredConversation {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        handle: row.get(2)?,
                        avatar: row.get(3)?,
                        subtitle: row.get(4)?,
                        can_write: row.get::<_, i64>(5)? != 0,
                        last_message: row.get(6)?,
                        last_message_at: row.get(7)?,
                        pinned: row.get::<_, i64>(8)? != 0,
                        online: row.get::<_, i64>(9)? != 0,
                        last_seen_at: None,
                        unread: 0,
                    })
                },
            )
            .optional()?
        {
            transaction.commit()?;
            return Ok(existing);
        }

        let id = format!("direct:{}", Uuid::new_v4());
        transaction.execute(
            "INSERT INTO conversations (id, owner_account_id, name, handle, avatar, subtitle, can_write, last_message, pinned, online, sort_order, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, '', 0, 0, 10, ?7, ?7)",
            params![id, account_id, name, handle, avatar, subtitle, now],
        )?;
        transaction.commit()?;
        Ok(StoredConversation {
            id,
            name: name.to_owned(),
            handle: Some(handle.to_owned()),
            avatar: avatar.to_owned(),
            subtitle: subtitle.map(str::to_owned),
            can_write: true,
            last_message: String::new(),
            last_message_at: None,
            pinned: false,
            online: false,
            last_seen_at: None,
            unread: 0,
        })
    }

    pub fn insert_message(
        &mut self,
        account_id: &str,
        conversation_id: &str,
        client_message_id: &str,
        message_json: &str,
        created_at: i64,
    ) -> SqlResult<Option<StoredMessage>> {
        let transaction = self.connection.transaction()?;
        let conversation_exists = transaction
            .query_row(
                "SELECT can_write FROM conversations WHERE owner_account_id = ?1 AND id = ?2",
                params![account_id, conversation_id],
                |row| Ok(row.get::<_, i64>(0)? != 0),
            )
            .optional()?;
        let Some(can_write) = conversation_exists else {
            return Ok(None);
        };
        if !can_write {
            return Ok(None);
        }

        if let Some(existing) = transaction.query_row(
            "SELECT id, conversation_id, author, created_at, stack_id, message_json FROM messages WHERE owner_account_id = ?1 AND client_message_id = ?2",
            params![account_id, client_message_id],
            |row| Ok(StoredMessage { id: row.get(0)?, conversation_id: row.get(1)?, author: row.get(2)?, created_at: row.get(3)?, stack_id: row.get(4)?, message_json: row.get(5)? }),
        ).optional()? {
            transaction.commit()?;
            return Ok(Some(existing));
        }

        let stack_id = message_stack_id(conversation_id, "me", created_at);
        transaction.execute(
            "INSERT INTO messages (id, owner_account_id, conversation_id, author, text, message_json, created_at, stack_id, client_message_id) VALUES (?1, ?2, ?3, 'me', '', ?4, ?5, ?6, ?1)",
            params![client_message_id, account_id, conversation_id, message_json, created_at, stack_id],
        )?;
        transaction.execute(
            "UPDATE conversations SET last_message = '', last_message_at = ?1, updated_at = ?1 WHERE owner_account_id = ?2 AND id = ?3",
            params![created_at, account_id, conversation_id],
        )?;
        let message = StoredMessage {
            id: client_message_id.to_owned(),
            conversation_id: conversation_id.to_owned(),
            author: "me".to_owned(),
            created_at,
            stack_id,
            message_json: message_json.to_owned(),
        };
        append_sqlite_message_event(&transaction, account_id, &message)?;
        transaction.commit()?;
        Ok(Some(message))
    }

    pub fn add_device_message_copy(
        &mut self,
        account_id: &str,
        conversation_id: &str,
        message_id: &str,
        source_key_id: Option<&str>,
        target_key_id: &str,
        message_json: &str,
    ) -> SqlResult<bool> {
        let transaction = self.connection.transaction()?;
        let source_delivery_id = source_key_id
            .filter(|value| !value.is_empty())
            .map(|value| format!("{message_id}:{value}"));
        let source = transaction
            .query_row(
                "SELECT author, created_at FROM messages
                 WHERE owner_account_id = ?1 AND conversation_id = ?2
                   AND (id = ?3 OR client_message_id = ?4)
                 ORDER BY seq ASC LIMIT 1",
                params![account_id, conversation_id, message_id, source_delivery_id,],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
            )
            .optional()?;
        let Some((author, created_at)) = source else {
            transaction.commit()?;
            return Ok(false);
        };
        let copy_id = format!("device-copy:{account_id}:{message_id}:{target_key_id}");
        let stack_id = message_stack_id(conversation_id, &author, created_at);
        let inserted = transaction.execute(
            "INSERT OR IGNORE INTO messages (id, owner_account_id, conversation_id, author, text, message_json, created_at, stack_id, client_message_id)
             VALUES (?1, ?2, ?3, ?4, '', ?5, ?6, ?7, ?1)",
            params![copy_id, account_id, conversation_id, author, message_json, created_at, stack_id],
        )?;
        if inserted > 0 {
            append_sqlite_message_event(
                &transaction,
                account_id,
                &StoredMessage {
                    id: copy_id,
                    conversation_id: conversation_id.to_owned(),
                    author: author.to_owned(),
                    created_at,
                    stack_id,
                    message_json: message_json.to_owned(),
                },
            )?;
        }
        transaction.commit()?;
        Ok(inserted > 0)
    }

    pub fn deliver_message(
        &mut self,
        account_id: &str,
        _conversation_id: &str,
        peer_address: &str,
        peer_name: &str,
        peer_avatar: &str,
        delivery_id: &str,
        message_json: &str,
        created_at: i64,
    ) -> SqlResult<Option<StoredMessage>> {
        let transaction = self.connection.transaction()?;
        if transaction
            .query_row(
                "SELECT id FROM messages WHERE owner_account_id = ?1 AND client_message_id = ?2",
                params![account_id, delivery_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .is_some()
        {
            transaction.commit()?;
            return Ok(None);
        }

        let target_conversation_id = transaction
            .query_row(
                "SELECT id FROM conversations WHERE owner_account_id = ?1 AND handle = ?2",
                params![account_id, peer_address],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        let target_conversation_id = if let Some(id) = target_conversation_id {
            id
        } else {
            let id = format!("direct:{}", Uuid::new_v4());
            transaction.execute(
                "INSERT INTO conversations (id, owner_account_id, name, handle, avatar, subtitle, can_write, last_message, pinned, online, sort_order, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?4, 1, '', 0, 0, 10, ?6, ?6)",
                params![&id, account_id, peer_name, peer_address, peer_avatar, created_at],
            )?;
            id
        };
        let stored_id = format!("inbound:{account_id}:{delivery_id}");
        let stack_id = message_stack_id(&target_conversation_id, "them", created_at);

        transaction.execute(
            "INSERT INTO messages (id, owner_account_id, conversation_id, author, text, message_json, created_at, stack_id, client_message_id) VALUES (?1, ?2, ?3, 'them', '', ?4, ?5, ?6, ?7)",
            params![stored_id, account_id, target_conversation_id, message_json, created_at, stack_id, delivery_id],
        )?;
        transaction.execute(
            "UPDATE conversations SET last_message = '', last_message_at = ?1, updated_at = ?1 WHERE owner_account_id = ?2 AND id = ?3",
            params![created_at, account_id, target_conversation_id],
        )?;
        let message = StoredMessage {
            id: stored_id,
            conversation_id: target_conversation_id,
            author: "them".to_owned(),
            created_at,
            stack_id,
            message_json: message_json.to_owned(),
        };
        append_sqlite_message_event(&transaction, account_id, &message)?;
        transaction.commit()?;
        Ok(Some(message))
    }

    pub fn register_device_key(
        &mut self,
        account_id: &str,
        key: &StoredDeviceKey,
        updated_at: i64,
    ) -> SqlResult<()> {
        self.connection.execute(
            "INSERT INTO device_keys (owner_account_id, device_id, key_id, encryption_public_key, signing_public_key, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(owner_account_id, device_id) DO UPDATE SET key_id = excluded.key_id, encryption_public_key = excluded.encryption_public_key, signing_public_key = excluded.signing_public_key, updated_at = excluded.updated_at",
            params![
                account_id,
                key.device_id,
                key.key_id,
                key.encryption_public_key,
                key.signing_public_key,
                key.created_at,
                updated_at
            ],
        )?;
        Ok(())
    }

    pub fn mark_message_delivered(
        &mut self,
        message_id: &str,
        recipient_account_id: &str,
        delivered_at: i64,
    ) -> SqlResult<Option<StoredEvent>> {
        let transaction = self.connection.transaction()?;
        let Some(account_id) = transaction
            .query_row(
                "SELECT owner_account_id FROM messages WHERE id = ?1 AND author = 'me' LIMIT 1",
                params![message_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
        else {
            transaction.commit()?;
            return Ok(None);
        };
        let recipient_has_copy = transaction
            .query_row(
                "SELECT 1 FROM messages
                 WHERE owner_account_id = ?1 AND author = 'them' AND json_valid(message_json)
                   AND json_extract(message_json, '$.message_id') = ?2
                 LIMIT 1",
                params![recipient_account_id, message_id],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        if !recipient_has_copy {
            transaction.commit()?;
            return Ok(None);
        }
        let changed = transaction.execute(
            "INSERT INTO message_delivery_receipts (message_id, recipient_account_id, delivered_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(message_id, recipient_account_id) DO NOTHING",
            params![message_id, recipient_account_id, delivered_at],
        )?;
        let event = if changed == 0 {
            None
        } else {
            let cursor = append_sqlite_receipt_event(
                &transaction,
                &account_id,
                "deliveryReceipt",
                message_id,
                delivered_at,
                delivered_at,
            )?;
            Some(StoredEvent::DeliveryReceipt {
                account_id,
                cursor,
                message_id: message_id.to_owned(),
                delivered_at,
            })
        };
        transaction.commit()?;
        Ok(event)
    }

    pub fn device_keys_for_handle(&self, handle: &str) -> SqlResult<Option<Vec<StoredDeviceKey>>> {
        let mut statement = self.connection.prepare(
            "SELECT device_id, key_id, encryption_public_key, signing_public_key, device_keys.created_at
             FROM device_keys JOIN accounts ON accounts.id = device_keys.owner_account_id
             WHERE accounts.handle = ?1 ORDER BY device_keys.updated_at DESC",
        )?;
        let keys = statement
            .query_map(params![handle], |row| {
                Ok(StoredDeviceKey {
                    device_id: row.get(0)?,
                    key_id: row.get(1)?,
                    encryption_public_key: row.get(2)?,
                    signing_public_key: row.get(3)?,
                    created_at: row.get(4)?,
                })
            })?
            .collect::<SqlResult<Vec<_>>>()?;
        if keys.is_empty() {
            Ok(None)
        } else {
            Ok(Some(keys))
        }
    }

    pub fn has_device_key(&self, account_id: &str, device_id: &str) -> SqlResult<bool> {
        self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM device_keys WHERE owner_account_id = ?1 AND device_id = ?2)",
            params![account_id, device_id],
            |row| row.get(0),
        )
    }

    pub fn has_device_key_id(&self, account_id: &str, key_id: &str) -> SqlResult<bool> {
        self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM device_keys WHERE owner_account_id = ?1 AND key_id = ?2)",
            params![account_id, key_id],
            |row| row.get(0),
        )
    }

    pub fn register_account_key(
        &mut self,
        account_id: &str,
        key_id: &str,
        encryption_public_key: &str,
        updated_at: i64,
    ) -> SqlResult<()> {
        self.connection.execute(
            "INSERT INTO account_keys (owner_account_id, key_id, encryption_public_key, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(owner_account_id) DO UPDATE SET key_id = excluded.key_id, encryption_public_key = excluded.encryption_public_key, updated_at = excluded.updated_at",
            params![account_id, key_id, encryption_public_key, updated_at, updated_at],
        )?;
        Ok(())
    }

    pub fn account_key_for_handle(&self, handle: &str) -> SqlResult<Option<StoredAccountKey>> {
        self.connection
            .query_row(
                "SELECT account_keys.key_id, account_keys.encryption_public_key
                 FROM account_keys JOIN accounts ON accounts.id = account_keys.owner_account_id
                 WHERE accounts.handle = ?1",
                params![handle],
                |row| {
                    Ok(StoredAccountKey {
                        key_id: row.get(0)?,
                        encryption_public_key: row.get(1)?,
                    })
                },
            )
            .optional()
    }

    pub fn has_account_key_id(&self, account_id: &str, key_id: &str) -> SqlResult<bool> {
        self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM account_keys WHERE owner_account_id = ?1 AND key_id = ?2)",
            params![account_id, key_id],
            |row| row.get(0),
        )
    }
}

fn ensure_system_conversations(
    transaction: &Transaction<'_>,
    account_id: &str,
    now: i64,
) -> SqlResult<()> {
    transaction.execute(
        "INSERT OR IGNORE INTO conversations (id, owner_account_id, name, handle, avatar, subtitle, can_write, last_message, pinned, online, sort_order, created_at, updated_at)
         VALUES (?1, ?2, 'Enter', 'official', 'enter-official', 'Официальный чат', 0, '', 1, 1, 0, ?3, ?3)",
        params![format!("enter:{account_id}"), account_id, now],
    )?;
    transaction.execute(
        "INSERT OR IGNORE INTO conversations (id, owner_account_id, name, handle, avatar, subtitle, can_write, last_message, pinned, online, sort_order, created_at, updated_at)
         VALUES (?1, ?2, 'Избранное', 'favorites', 'favorites', 'Личные сохранения', 1, '', 1, 0, 1, ?3, ?3)",
        params![format!("favorites:{account_id}"), account_id, now],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn account() -> StoredAccount {
        StoredAccount {
            id: "account-1".to_owned(),
            name: "Alice".to_owned(),
            handle: "alice".to_owned(),
            password_hash: "hash".to_owned(),
        }
    }

    #[test]
    fn account_settings_round_trip_with_safe_defaults() {
        let mut storage = SqliteStorage::open(":memory:").expect("open settings database");
        let account = account();
        storage.create_account(&account, 1).expect("create account");
        assert_eq!(
            storage
                .account_settings(&account.id)
                .expect("read defaults"),
            AccountSettings::default()
        );
        let settings = AccountSettings {
            show_online: false,
            show_last_seen: false,
            read_receipts: true,
            typing_indicators: false,
        };
        storage
            .update_account_settings(&account.id, &settings, 2)
            .expect("write settings");
        assert_eq!(
            storage
                .account_settings(&account.id)
                .expect("read settings"),
            settings
        );
    }

    #[test]
    fn account_folders_round_trip_and_sync() {
        let mut storage = SqliteStorage::open(":memory:").expect("open folders database");
        let account = account();
        storage.create_account(&account, 1).expect("create account");
        let folders = vec![StoredFolder {
            id: "work".to_owned(),
            name: "Работа".to_owned(),
            template: "custom".to_owned(),
            icon: "folder".to_owned(),
            chat_ids: vec!["chat-1".to_owned()],
        }];

        storage
            .update_account_folders(&account.id, &folders, 2)
            .expect("write folders");

        assert_eq!(storage.account_folders(&account.id).expect("read folders"), folders);
        assert_eq!(storage.sync(&account.id, 0, "").expect("sync").folders, folders);
    }

    #[test]
    fn sessions_are_addressable_without_exposing_tokens() {
        let mut storage = SqliteStorage::open(":memory:").expect("open session database");
        let account = account();
        storage.create_account(&account, 1).expect("create account");
        storage
            .store_session_with_metadata(
                "secret-token",
                &account.id,
                100,
                Some("device-1"),
                Some("desktop"),
                Some("Workstation"),
                Some("0.2.0"),
            )
            .expect("store session");
        let sessions = storage
            .list_sessions(&account.id, "secret-token", 100)
            .expect("list sessions");
        assert_eq!(sessions.len(), 1);
        assert_ne!(sessions[0].id, "secret-token");
        assert_eq!(sessions[0].device_id.as_deref(), Some("device-1"));
        assert_eq!(sessions[0].platform, "desktop");
        assert_eq!(sessions[0].device_name.as_deref(), Some("Workstation"));
        assert_eq!(sessions[0].app_version.as_deref(), Some("0.2.0"));
        assert!(sessions[0].current);
        assert!(storage
            .update_session_metadata(
                &account.id,
                "secret-token",
                Some("web"),
                Some("Chrome · macOS"),
                Some("0.2.1"),
                101,
            )
            .expect("refresh session metadata"));
        let refreshed = storage
            .list_sessions(&account.id, "secret-token", 101)
            .expect("list refreshed session");
        assert_eq!(refreshed[0].platform, "web");
        assert_eq!(refreshed[0].device_name.as_deref(), Some("Chrome · macOS"));
        assert_eq!(refreshed[0].app_version.as_deref(), Some("0.2.1"));
        assert!(storage
            .revoke_session_by_id(&account.id, &sessions[0].id)
            .expect("revoke session"));
    }

    #[test]
    fn revoking_a_device_revokes_its_sessions_and_keys() {
        let mut storage = SqliteStorage::open(":memory:").expect("open device database");
        let account = account();
        storage.create_account(&account, 1).expect("create account");
        storage
            .upsert_device(
                &account.id,
                "device-1",
                "mobile",
                Some("Phone"),
                Some("0.2.0"),
                2,
            )
            .expect("store device");
        storage
            .upsert_device(&account.id, "device-1", "unknown", None, None, 3)
            .expect("preserve device metadata");
        let device = &storage.list_devices(&account.id).expect("list device")[0];
        assert_eq!(device.platform, "mobile");
        assert_eq!(device.name.as_deref(), Some("Phone"));
        assert_eq!(device.app_version.as_deref(), Some("0.2.0"));
        storage
            .register_device_key(
                &account.id,
                &StoredDeviceKey {
                    device_id: "device-1".to_owned(),
                    key_id: "key-1".to_owned(),
                    encryption_public_key: "encryption".to_owned(),
                    signing_public_key: "signing".to_owned(),
                    created_at: 2,
                },
                2,
            )
            .expect("store device key");
        storage
            .store_session_with_metadata(
                "device-token",
                &account.id,
                2,
                Some("device-1"),
                Some("mobile"),
                Some("Phone"),
                Some("0.2.0"),
            )
            .expect("store device session");
        assert!(storage
            .revoke_device(&account.id, "device-1", 3)
            .expect("revoke device"));
        assert!(!storage
            .has_device_key(&account.id, "device-1")
            .expect("check revoked key"));
        assert!(storage
            .list_sessions(&account.id, "device-token", 3)
            .expect("list revoked sessions")
            .is_empty());
        assert_eq!(
            storage.list_devices(&account.id).expect("list device")[0].revoked_at,
            Some(3)
        );
    }

    #[test]
    fn loopback_alias_requires_a_matching_explicit_port() {
        assert!(same_local_server(
            "https://example.test:50121",
            "localhost:50121"
        ));
        assert!(!same_local_server("https://example.test", "localhost"));
    }

    #[test]
    fn persists_system_chats_and_cursor_messages() {
        let mut storage = SqliteStorage::open(":memory:").expect("open memory database");
        let account = account();
        assert!(storage.create_account(&account, 1).expect("create account"));
        storage
            .register_device_key(
                &account.id,
                &StoredDeviceKey {
                    device_id: "device-1".to_owned(),
                    key_id: "key-1".to_owned(),
                    encryption_public_key: "encryption".to_owned(),
                    signing_public_key: "signing".to_owned(),
                    created_at: 1,
                },
                1,
            )
            .expect("register device key");
        assert!(storage
            .has_device_key(&account.id, "device-1")
            .expect("find device key"));

        let initial = storage.sync(&account.id, 0, "").expect("initial sync");
        assert_eq!(initial.conversations.len(), 2);
        assert_eq!(initial.cursor, 0);

        let message = storage
            .insert_message(
                &account.id,
                "favorites:account-1",
                "client-1",
                "{\"ciphertext\":\"one\"}",
                2,
            )
            .expect("insert message")
            .expect("writable conversation");
        assert_eq!(message.id, "client-1");
        assert_eq!(message.stack_id, "favorites:account-1:me:0");
        assert_eq!(
            storage
                .account_by_handle_prefix("ali")
                .expect("search account")
                .expect("matching account")
                .handle,
            "alice"
        );

        let synced = storage.sync(&account.id, 0, "").expect("message sync");
        assert_eq!(synced.messages.len(), 1);
        assert_eq!(synced.cursor, 1);
        assert!(matches!(
            storage
                .events_since(&account.id, 0)
                .expect("replay events")
                .as_slice(),
            [StoredEvent::Message { cursor: 1, .. }]
        ));
        assert_eq!(
            storage
                .sync(&account.id, synced.cursor, "")
                .expect("empty sync")
                .messages
                .len(),
            0
        );
    }

    #[test]
    fn replaces_push_token_for_a_device() {
        let mut storage = SqliteStorage::open(":memory:").expect("open memory database");
        let account = account();
        storage.create_account(&account, 1).expect("create account");
        storage
            .register_push_token(
                &account.id,
                "device-1",
                "ExponentPushToken[first]",
                "android",
                2,
            )
            .expect("register first token");
        storage
            .register_push_token(
                &account.id,
                "device-1",
                "ExponentPushToken[second]",
                "android",
                3,
            )
            .expect("replace token");
        assert_eq!(
            storage.push_tokens(&account.id).expect("list tokens"),
            vec!["ExponentPushToken[second]".to_owned()]
        );
    }

    #[test]
    fn sessions_expire_and_can_be_revoked() {
        let mut storage = SqliteStorage::open(":memory:").expect("open session database");
        let account = account();
        storage.create_account(&account, 1).expect("create account");
        storage
            .store_session("session-1", &account.id, 100)
            .expect("store session");
        assert_eq!(
            storage
                .account_id_for_session("session-1", 100 + SESSION_TTL_MS - 1)
                .expect("find live session"),
            Some(account.id.clone())
        );
        assert!(storage
            .account_id_for_session("session-1", 100 + SESSION_TTL_MS)
            .expect("find expired session")
            .is_none());
        storage
            .store_session("session-2", &account.id, 100)
            .expect("store second session");
        assert!(storage.revoke_session("session-2").expect("revoke session"));
        assert!(!storage
            .revoke_session("session-2")
            .expect("revoke missing session"));
    }

    #[test]
    fn media_is_idempotent_and_scoped_to_sender_or_recipient() {
        let mut storage = SqliteStorage::open(":memory:").expect("open media database");
        let owner = account();
        let recipient = StoredAccount {
            id: "account-2".to_owned(),
            name: "Bob".to_owned(),
            handle: "bob".to_owned(),
            password_hash: "hash".to_owned(),
        };
        let stranger = StoredAccount {
            id: "account-3".to_owned(),
            name: "Eve".to_owned(),
            handle: "eve".to_owned(),
            password_hash: "hash".to_owned(),
        };
        storage.create_account(&owner, 1).expect("create owner");
        storage
            .create_account(&recipient, 1)
            .expect("create recipient");
        storage
            .create_account(&stranger, 1)
            .expect("create stranger");
        assert!(storage
            .store_media(
                &owner.id,
                &recipient.id,
                "direct-1",
                "media-1",
                b"ciphertext",
                2
            )
            .expect("store media"));
        assert!(!storage
            .store_media(
                &owner.id,
                &recipient.id,
                "direct-1",
                "media-1",
                b"changed",
                3
            )
            .expect("repeat media"));
        assert_eq!(
            storage
                .media_bytes(&owner.id, "media-1")
                .expect("owner media"),
            Some(b"ciphertext".to_vec())
        );
        assert_eq!(
            storage
                .media_bytes(&recipient.id, "media-1")
                .expect("recipient media"),
            Some(b"ciphertext".to_vec())
        );
        assert_eq!(
            storage
                .media_bytes(&stranger.id, "media-1")
                .expect("stranger media"),
            None
        );
    }

    #[test]
    fn event_log_survives_storage_reopen() {
        let path = std::env::temp_dir().join(format!("enter-event-log-{}.db", Uuid::new_v4()));
        let path_string = path.to_string_lossy().into_owned();
        {
            let mut storage = SqliteStorage::open(&path_string).expect("open event database");
            let account = account();
            storage.create_account(&account, 1).expect("create account");
            storage
                .insert_message(
                    &account.id,
                    "favorites:account-1",
                    "durable-message",
                    r#"{"message_id":"durable-message"}"#,
                    2,
                )
                .expect("insert message")
                .expect("writable conversation");
        }
        let storage = SqliteStorage::open(&path_string).expect("reopen event database");
        assert!(matches!(
            storage
                .events_since("account-1", 0)
                .expect("replay durable event")
                .as_slice(),
            [StoredEvent::Message { cursor: 1, .. }]
        ));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn sync_pages_large_event_backlogs_without_skipping_cursor() {
        let mut storage = SqliteStorage::open(":memory:").expect("open sync database");
        let account = account();
        storage.create_account(&account, 1).expect("create account");
        for index in 0..=MAX_SYNC_EVENTS {
            let message_id = format!("sync-message-{index}");
            storage
                .insert_message(
                    &account.id,
                    "favorites:account-1",
                    &message_id,
                    &format!(r#"{{"message_id":"{message_id}"}}"#),
                    index + 2,
                )
                .expect("insert message")
                .expect("writable conversation");
        }

        let first = storage.sync(&account.id, 0, "").expect("first sync page");
        assert_eq!(first.messages.len(), MAX_SYNC_EVENTS as usize);
        assert_eq!(first.cursor, MAX_SYNC_EVENTS);

        let second = storage
            .sync(&account.id, first.cursor, "")
            .expect("second sync page");
        assert_eq!(second.messages.len(), 1);
        assert_eq!(second.cursor, MAX_SYNC_EVENTS + 1);
    }

    #[test]
    fn message_delivery_is_idempotent() {
        let mut storage = SqliteStorage::open(":memory:").expect("open memory database");
        let account = account();
        let recipient = StoredAccount {
            id: "account-2".to_owned(),
            name: "Bob".to_owned(),
            handle: "bob".to_owned(),
            password_hash: "hash".to_owned(),
        };
        storage.create_account(&account, 1).expect("create account");
        storage
            .create_account(&recipient, 1)
            .expect("create recipient");

        let first = storage
            .insert_message(
                &account.id,
                "favorites:account-1",
                "client-1",
                "{\"ciphertext\":\"one\"}",
                2,
            )
            .expect("insert message")
            .expect("writable conversation");
        let second = storage
            .insert_message(
                &account.id,
                "favorites:account-1",
                "client-1",
                "{\"ciphertext\":\"two\"}",
                3,
            )
            .expect("repeat message")
            .expect("existing message");
        assert_eq!(first.message_json, second.message_json);

        let delivered = storage
            .deliver_message(
                &recipient.id,
                "direct-1",
                "alice@example.test",
                "Alice",
                "alice",
                "client-1",
                "{\"encrypted_message\":true}",
                2,
            )
            .expect("deliver message")
            .expect("stored delivery");
        assert_eq!(delivered.author, "them");
        assert!(delivered.conversation_id.starts_with("direct:"));
        let reverse = storage
            .deliver_message(
                &account.id,
                "direct-1",
                "bob@example.test",
                "Bob",
                "bob",
                "client-2",
                "{\"encrypted_message\":\"reverse\"}",
                2,
            )
            .expect("deliver reverse message")
            .expect("stored reverse delivery");
        assert!(reverse.conversation_id.starts_with("direct:"));
        assert_eq!(
            storage
                .sync(&recipient.id, 0, "")
                .expect("recipient sync")
                .messages
                .len(),
            1
        );
        assert_eq!(
            storage
                .deliver_message(
                    &recipient.id,
                    "direct-1",
                    "alice@example.test",
                    "Alice",
                    "alice",
                    "client-1",
                    "{\"encrypted_message\":false}",
                    3,
                )
                .expect("repeat delivery")
                .is_none(),
            true
        );
        storage
            .deliver_message(
                &recipient.id,
                "direct-1",
                "alice@example.test",
                "Alice",
                "alice",
                "client-1:key-2",
                "{\"encrypted_message\":2}",
                4,
            )
            .expect("deliver second device copy")
            .expect("stored second device copy");
        assert_eq!(
            storage
                .sync(&recipient.id, 0, "")
                .expect("recipient sync with device copies")
                .messages
                .len(),
            2
        );
    }

    #[test]
    fn tracks_presence_unread_messages_and_read_receipts() {
        let mut storage = SqliteStorage::open(":memory:").expect("open memory database");
        let account = account();
        let recipient = StoredAccount {
            id: "account-2".to_owned(),
            name: "Bob".to_owned(),
            handle: "bob".to_owned(),
            password_hash: "hash".to_owned(),
        };
        storage.create_account(&account, 1).expect("create account");
        storage
            .create_account(&recipient, 1)
            .expect("create recipient");
        storage
            .touch_presence(&recipient.id, 5)
            .expect("touch recipient presence");

        storage
            .deliver_message(
                &recipient.id,
                "direct-1",
                "alice@example.test",
                "Alice",
                "alice",
                "incoming-1",
                r#"{"message_id":"message-1"}"#,
                2,
            )
            .expect("deliver incoming message")
            .expect("stored incoming message");
        storage
            .deliver_message(
                &recipient.id,
                "direct-1",
                "alice@example.test",
                "Alice",
                "alice",
                "incoming-1:key-2",
                r#"{"message_id":"message-1","key_id":"key-2"}"#,
                2,
            )
            .expect("deliver device copy")
            .expect("stored device copy");
        let sender_conversation = storage
            .deliver_message(
                &account.id,
                "direct-1",
                "bob@example.test",
                "Bob",
                "bob",
                "peer-copy-1",
                r#"{"message_id":"peer-copy-1"}"#,
                2,
            )
            .expect("create sender conversation")
            .expect("stored sender copy");
        storage
            .create_direct_conversation(
                &account.id,
                "bob@evil.example",
                "Bob",
                "bob",
                Some("bob@evil.example"),
                2,
            )
            .expect("create wrong-server sender conversation");
        let watchers = storage
            .presence_watchers(&recipient.id, "example.test")
            .expect("find presence watchers");
        assert_eq!(watchers.len(), 1);
        assert_eq!(watchers[0].owner_account_id, account.id);
        assert_eq!(
            watchers[0].conversation_id,
            sender_conversation.conversation_id
        );
        storage
            .insert_message(
                &account.id,
                &sender_conversation.conversation_id,
                "message-1",
                r#"{"message_id":"message-1"}"#,
                2,
            )
            .expect("insert outgoing message")
            .expect("writable sender conversation");
        assert!(storage
            .sync(&account.id, 0, "example.test")
            .expect("sync before delivery ACK")
            .delivery_receipts
            .is_empty());
        assert!(storage
            .mark_message_delivered("message-1", &recipient.id, 4)
            .expect("mark message delivered")
            .is_some());
        assert!(storage
            .mark_message_delivered("message-1", &recipient.id, 5)
            .expect("repeat delivery ACK")
            .is_none());

        let before_read = storage
            .sync(&recipient.id, 0, "example.test")
            .expect("sync unread");
        let recipient_conversation = before_read
            .conversations
            .iter()
            .find(|conversation| conversation.id.starts_with("direct:"))
            .expect("recipient conversation");
        assert_eq!(recipient_conversation.unread, 1);

        storage
            .mark_conversation_read(&recipient.id, &recipient_conversation.id, 3)
            .expect("mark conversation read");
        let after_read = storage
            .sync(&recipient.id, 0, "example.test")
            .expect("sync read state");
        assert_eq!(
            after_read
                .conversations
                .iter()
                .find(|conversation| conversation.id == recipient_conversation.id)
                .expect("read recipient conversation")
                .unread,
            0
        );

        let sender_sync = storage
            .sync(&account.id, 0, "example.test")
            .expect("sync read receipt");
        assert_eq!(
            sender_sync
                .conversations
                .iter()
                .find(|conversation| conversation.id == sender_conversation.conversation_id)
                .and_then(|conversation| conversation.last_seen_at),
            Some(5)
        );
        assert_eq!(
            sender_sync
                .conversations
                .iter()
                .find(|conversation| conversation.id == sender_conversation.conversation_id)
                .and_then(|conversation| conversation.subtitle.as_deref()),
            Some("bob@example.test")
        );
        assert_eq!(
            sender_sync
                .read_receipts
                .iter()
                .find(|receipt| receipt.message_id == "message-1")
                .map(|receipt| receipt.read_at),
            Some(3)
        );
        assert_eq!(
            sender_sync
                .delivery_receipts
                .iter()
                .find(|receipt| receipt.message_id == "message-1")
                .map(|receipt| receipt.delivered_at),
            Some(4)
        );
        assert_eq!(sender_sync.cursor, 4);
        let replay = storage
            .sync(&account.id, 2, "example.test")
            .expect("replay receipts");
        assert_eq!(replay.messages.len(), 0);
        assert_eq!(replay.read_receipts.len(), 1);
        assert_eq!(replay.delivery_receipts.len(), 1);
        assert_eq!(storage.cursor(&recipient.id).expect("recipient cursor"), 2);
    }
}

#[derive(Debug)]
pub enum StorageError {
    Sqlite(rusqlite::Error),
    Postgres(sqlx::Error),
    InvalidEvent(String),
    LockPoisoned,
    UnsupportedDatabase(String),
}

impl fmt::Display for StorageError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Sqlite(error) => write!(formatter, "SQLite storage error: {error}"),
            Self::Postgres(error) => write!(formatter, "PostgreSQL storage error: {error}"),
            Self::InvalidEvent(error) => write!(formatter, "invalid realtime event: {error}"),
            Self::LockPoisoned => formatter.write_str("storage lock is poisoned"),
            Self::UnsupportedDatabase(url) => write!(formatter, "unsupported database URL: {url}"),
        }
    }
}

impl std::error::Error for StorageError {}

impl From<rusqlite::Error> for StorageError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Sqlite(error)
    }
}

impl From<sqlx::Error> for StorageError {
    fn from(error: sqlx::Error) -> Self {
        Self::Postgres(error)
    }
}

fn decode_postgres_event(
    account_id: &str,
    cursor: i64,
    kind: &str,
    payload_json: &str,
) -> Result<StoredEvent, StorageError> {
    match kind {
        "message" => Ok(StoredEvent::Message {
            account_id: account_id.to_owned(),
            cursor,
            message: serde_json::from_str(payload_json)
                .map_err(|error| StorageError::InvalidEvent(error.to_string()))?,
        }),
        "readReceipt" => {
            let payload: StoredReadReceipt = serde_json::from_str(payload_json)
                .map_err(|error| StorageError::InvalidEvent(error.to_string()))?;
            Ok(StoredEvent::ReadReceipt {
                account_id: account_id.to_owned(),
                cursor,
                message_id: payload.message_id,
                read_at: payload.read_at,
            })
        }
        "deliveryReceipt" => {
            let payload: StoredDeliveryReceipt = serde_json::from_str(payload_json)
                .map_err(|error| StorageError::InvalidEvent(error.to_string()))?;
            Ok(StoredEvent::DeliveryReceipt {
                account_id: account_id.to_owned(),
                cursor,
                message_id: payload.message_id,
                delivered_at: payload.delivered_at,
            })
        }
        other => Err(StorageError::InvalidEvent(format!(
            "unknown event kind {other}"
        ))),
    }
}

async fn append_postgres_event(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    account_id: &str,
    kind: &str,
    source_id: &str,
    payload_json: &str,
    created_at: i64,
) -> Result<i64, StorageError> {
    if let Some(row) = sqlx::query(
        "SELECT cursor FROM realtime_events WHERE account_id = $1 AND kind = $2 AND source_id = $3",
    )
    .bind(account_id)
    .bind(kind)
    .bind(source_id)
    .fetch_optional(&mut **transaction)
    .await?
    {
        return Ok(row.try_get("cursor")?);
    }
    sqlx::query(
        "INSERT INTO realtime_event_cursors (account_id, cursor) VALUES ($1, 0) ON CONFLICT (account_id) DO NOTHING",
    )
    .bind(account_id)
    .execute(&mut **transaction)
    .await?;
    let cursor = sqlx::query(
        "UPDATE realtime_event_cursors SET cursor = cursor + 1 WHERE account_id = $1 RETURNING cursor",
    )
    .bind(account_id)
    .fetch_one(&mut **transaction)
    .await?
    .try_get("cursor")?;
    sqlx::query(
        "INSERT INTO realtime_events (account_id, cursor, kind, source_id, payload_json, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(account_id)
    .bind(cursor)
    .bind(kind)
    .bind(source_id)
    .bind(payload_json)
    .bind(created_at)
    .execute(&mut **transaction)
    .await?;
    Ok(cursor)
}

async fn append_postgres_message_event(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    account_id: &str,
    message: &StoredMessage,
) -> Result<i64, StorageError> {
    let payload_json = serde_json::to_string(message)
        .map_err(|error| StorageError::InvalidEvent(error.to_string()))?;
    append_postgres_event(
        transaction,
        account_id,
        "message",
        &message.id,
        &payload_json,
        message.created_at,
    )
    .await
}

async fn append_postgres_receipt_event(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    account_id: &str,
    kind: &str,
    message_id: &str,
    value: i64,
) -> Result<i64, StorageError> {
    let payload_json = match kind {
        "readReceipt" => serde_json::to_string(&StoredReadReceipt {
            message_id: message_id.to_owned(),
            read_at: value,
        }),
        "deliveryReceipt" => serde_json::to_string(&StoredDeliveryReceipt {
            message_id: message_id.to_owned(),
            delivered_at: value,
        }),
        _ => return Err(StorageError::InvalidEvent(kind.to_owned())),
    }
    .map_err(|error| StorageError::InvalidEvent(error.to_string()))?;
    append_postgres_event(
        transaction,
        account_id,
        kind,
        &format!("{message_id}:{value}"),
        &payload_json,
        value,
    )
    .await
}

#[derive(Clone)]
enum StorageBackend {
    Sqlite(Arc<Mutex<SqliteStorage>>),
    Postgres(PgPool),
}

#[derive(Clone)]
pub struct Storage {
    backend: StorageBackend,
}

impl Storage {
    pub async fn open(database_url: &str) -> Result<Self, StorageError> {
        if database_url.starts_with("postgres://") || database_url.starts_with("postgresql://") {
            let pool = PgPoolOptions::new()
                .max_connections(10)
                .connect(database_url)
                .await?;
            migrate_postgres(&pool).await?;
            postgres_ensure_all_system_conversations(&pool, now_ms()).await?;
            return Ok(Self {
                backend: StorageBackend::Postgres(pool),
            });
        }

        if database_url.starts_with("sqlite:") || !database_url.contains("://") {
            return Ok(Self {
                backend: StorageBackend::Sqlite(Arc::new(Mutex::new(SqliteStorage::open(
                    database_url,
                )?))),
            });
        }

        Err(StorageError::UnsupportedDatabase(database_url.to_owned()))
    }

    pub async fn ensure_server_id(&self) -> Result<String, StorageError> {
        match &self.backend {
            StorageBackend::Sqlite(storage) => storage
                .lock()
                .map_err(|_| StorageError::LockPoisoned)?
                .ensure_server_id()
                .map_err(Into::into),
            StorageBackend::Postgres(pool) => {
                if let Some(row) =
                    sqlx::query("SELECT value FROM server_metadata WHERE key = 'server_id'")
                        .fetch_optional(pool)
                        .await?
                {
                    return Ok(row.try_get("value")?);
                }
                let id = new_server_id();
                sqlx::query("INSERT INTO server_metadata (key, value) VALUES ('server_id', $1) ON CONFLICT (key) DO NOTHING")
                    .bind(&id)
                    .execute(pool)
                    .await?;
                Ok(
                    sqlx::query("SELECT value FROM server_metadata WHERE key = 'server_id'")
                        .fetch_one(pool)
                        .await?
                        .try_get("value")?,
                )
            }
        }
    }

    pub async fn canonicalize_local_conversations(
        &self,
        public_server: &str,
    ) -> Result<(), StorageError> {
        match &self.backend {
            StorageBackend::Sqlite(storage) => storage
                .lock()
                .map_err(|_| StorageError::LockPoisoned)?
                .canonicalize_local_conversations(public_server)
                .map_err(Into::into),
            StorageBackend::Postgres(pool) => {
                let rows = sqlx::query(
                    "SELECT id, owner_account_id, handle FROM conversations WHERE handle IS NOT NULL AND handle NOT IN ('official', 'favorites')",
                )
                .fetch_all(pool)
                .await?;
                let canonical_server = canonical_server(public_server);
                let mut aliases: HashMap<(String, String), Vec<(String, String)>> = HashMap::new();
                for row in rows {
                    let id: String = row.try_get("id")?;
                    let owner_id: String = row.try_get("owner_account_id")?;
                    let handle: String = row.try_get("handle")?;
                    let Some((peer_handle, peer_server)) = handle.rsplit_once('@') else {
                        continue;
                    };
                    if same_local_server(public_server, peer_server) {
                        aliases
                            .entry((owner_id, format!("{peer_handle}@{canonical_server}")))
                            .or_default()
                            .push((id, handle));
                    }
                }
                let mut transaction = pool.begin().await?;
                for ((owner_id, canonical_handle), rows) in aliases {
                    let keeper = sqlx::query(
                        "SELECT id FROM conversations WHERE owner_account_id = $1 AND handle = $2",
                    )
                    .bind(&owner_id)
                    .bind(&canonical_handle)
                    .fetch_optional(&mut *transaction)
                    .await?
                    .map(|row| row.try_get::<String, _>("id"))
                    .transpose()?;
                    let keeper = if let Some(id) = keeper {
                        id
                    } else {
                        let id = rows[0].0.clone();
                        sqlx::query("UPDATE conversations SET handle = $1 WHERE owner_account_id = $2 AND id = $3")
                            .bind(&canonical_handle)
                            .bind(&owner_id)
                            .bind(&id)
                            .execute(&mut *transaction)
                            .await?;
                        id
                    };
                    for (source, _) in rows {
                        if source == keeper {
                            continue;
                        }
                        let source_state = sqlx::query("SELECT last_message, last_message_at, pinned, sort_order, updated_at FROM conversations WHERE owner_account_id = $1 AND id = $2")
                            .bind(&owner_id).bind(&source).fetch_one(&mut *transaction).await?;
                        let target_state = sqlx::query("SELECT last_message, last_message_at, pinned, sort_order, updated_at FROM conversations WHERE owner_account_id = $1 AND id = $2")
                            .bind(&owner_id).bind(&keeper).fetch_one(&mut *transaction).await?;
                        let source_updated: i64 = source_state.try_get("updated_at")?;
                        let target_updated: i64 = target_state.try_get("updated_at")?;
                        if source_updated > target_updated {
                            sqlx::query("UPDATE conversations SET last_message = $1, last_message_at = $2, updated_at = $3 WHERE owner_account_id = $4 AND id = $5")
                                .bind(source_state.try_get::<String, _>("last_message")?)
                                .bind(source_state.try_get::<Option<i64>, _>("last_message_at")?)
                                .bind(source_updated).bind(&owner_id).bind(&keeper)
                                .execute(&mut *transaction).await?;
                        }
                        sqlx::query("UPDATE conversations SET pinned = GREATEST(pinned, $1), sort_order = LEAST(sort_order, $2) WHERE owner_account_id = $3 AND id = $4")
                            .bind(source_state.try_get::<bool, _>("pinned")?)
                            .bind(source_state.try_get::<i64, _>("sort_order")?)
                            .bind(&owner_id).bind(&keeper).execute(&mut *transaction).await?;
                        sqlx::query("UPDATE messages SET conversation_id = $1 WHERE owner_account_id = $2 AND conversation_id = $3")
                            .bind(&keeper).bind(&owner_id).bind(&source).execute(&mut *transaction).await?;
                        let source_read = sqlx::query("SELECT read_at FROM conversation_reads WHERE owner_account_id = $1 AND conversation_id = $2")
                            .bind(&owner_id).bind(&source).fetch_optional(&mut *transaction).await?
                            .map(|row| row.try_get::<i64, _>("read_at")).transpose()?;
                        let target_read = sqlx::query("SELECT read_at FROM conversation_reads WHERE owner_account_id = $1 AND conversation_id = $2")
                            .bind(&owner_id).bind(&keeper).fetch_optional(&mut *transaction).await?
                            .map(|row| row.try_get::<i64, _>("read_at")).transpose()?;
                        if source_read.is_some() || target_read.is_some() {
                            let read_at = source_read
                                .into_iter()
                                .chain(target_read)
                                .max()
                                .unwrap_or(0);
                            sqlx::query("DELETE FROM conversation_reads WHERE owner_account_id = $1 AND conversation_id IN ($2, $3)")
                                .bind(&owner_id).bind(&source).bind(&keeper).execute(&mut *transaction).await?;
                            sqlx::query("INSERT INTO conversation_reads (owner_account_id, conversation_id, read_at) VALUES ($1, $2, $3)")
                                .bind(&owner_id).bind(&keeper).bind(read_at).execute(&mut *transaction).await?;
                        }
                        sqlx::query(
                            "DELETE FROM conversations WHERE owner_account_id = $1 AND id = $2",
                        )
                        .bind(&owner_id)
                        .bind(&source)
                        .execute(&mut *transaction)
                        .await?;
                    }
                }
                transaction.commit().await?;
                Ok(())
            }
        }
    }

    pub async fn create_account(
        &self,
        account: &StoredAccount,
        created_at: i64,
    ) -> Result<bool, StorageError> {
        match &self.backend {
            StorageBackend::Sqlite(storage) => storage
                .lock()
                .map_err(|_| StorageError::LockPoisoned)?
                .create_account(account, created_at)
                .map_err(Into::into),
            StorageBackend::Postgres(pool) => {
                let mut transaction = pool.begin().await?;
                let inserted = sqlx::query(
                    "INSERT INTO accounts (id, name, handle, password_hash, created_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (handle) DO NOTHING",
                )
                .bind(&account.id)
                .bind(&account.name)
                .bind(&account.handle)
                .bind(&account.password_hash)
                .bind(created_at)
                .execute(&mut *transaction)
                .await?
                .rows_affected()
                    > 0;
                if inserted {
                    sqlx::query(
                        "INSERT INTO realtime_event_cursors (account_id, cursor) VALUES ($1, 0) ON CONFLICT (account_id) DO NOTHING",
                    )
                    .bind(&account.id)
                    .execute(&mut *transaction)
                    .await?;
                    postgres_ensure_system_conversations(&mut transaction, &account.id, created_at)
                        .await?;
                }
                transaction.commit().await?;
                Ok(inserted)
            }
        }
    }

    pub async fn account_by_handle(
        &self,
        handle: &str,
    ) -> Result<Option<StoredAccount>, StorageError> {
        match &self.backend {
            StorageBackend::Sqlite(storage) => storage
                .lock()
                .map_err(|_| StorageError::LockPoisoned)?
                .account_by_handle(handle)
                .map_err(Into::into),
            StorageBackend::Postgres(pool) => sqlx::query(
                "SELECT id, name, handle, password_hash FROM accounts WHERE handle = $1",
            )
            .bind(handle)
            .fetch_optional(pool)
            .await?
            .map(|row| {
                Ok(StoredAccount {
                    id: row.try_get("id")?,
                    name: row.try_get("name")?,
                    handle: row.try_get("handle")?,
                    password_hash: row.try_get("password_hash")?,
                })
            })
            .transpose(),
        }
    }

    pub async fn account_by_id(
        &self,
        account_id: &str,
    ) -> Result<Option<StoredAccount>, StorageError> {
        match &self.backend {
            StorageBackend::Sqlite(storage) => storage
                .lock()
                .map_err(|_| StorageError::LockPoisoned)?
                .account_by_id(account_id)
                .map_err(Into::into),
            StorageBackend::Postgres(pool) => {
                sqlx::query("SELECT id, name, handle, password_hash FROM accounts WHERE id = $1")
                    .bind(account_id)
                    .fetch_optional(pool)
                    .await?
                    .map(|row| {
                        Ok(StoredAccount {
                            id: row.try_get("id")?,
                            name: row.try_get("name")?,
                            handle: row.try_get("handle")?,
                            password_hash: row.try_get("password_hash")?,
                        })
                    })
                    .transpose()
            }
        }
    }

    pub async fn account_by_handle_prefix(
        &self,
        prefix: &str,
    ) -> Result<Option<StoredAccount>, StorageError> {
        match &self.backend {
            StorageBackend::Sqlite(storage) => storage
                .lock()
                .map_err(|_| StorageError::LockPoisoned)?
                .account_by_handle_prefix(prefix)
                .map_err(Into::into),
            StorageBackend::Postgres(pool) => sqlx::query(
                "SELECT id, name, handle, password_hash FROM accounts WHERE handle LIKE $1 || '%' ORDER BY handle LIMIT 1",
            )
            .bind(prefix)
            .fetch_optional(pool)
            .await?
            .map(|row| {
                Ok(StoredAccount {
                    id: row.try_get("id")?,
                    name: row.try_get("name")?,
                    handle: row.try_get("handle")?,
                    password_hash: row.try_get("password_hash")?,
                })
            })
            .transpose(),
        }
    }

    pub async fn account_settings(
        &self,
        account_id: &str,
    ) -> Result<AccountSettings, StorageError> {
        match &self.backend {
            StorageBackend::Sqlite(storage) => storage
                .lock()
                .map_err(|_| StorageError::LockPoisoned)?
                .account_settings(account_id)
                .map_err(Into::into),
            StorageBackend::Postgres(pool) => {
                let raw =
                    sqlx::query("SELECT value_json FROM account_settings WHERE account_id = $1")
                        .bind(account_id)
                        .fetch_optional(pool)
                        .await?;
                Ok(raw
                    .and_then(|row| row.try_get::<String, _>("value_json").ok())
                    .and_then(|value| serde_json::from_str(&value).ok())
                    .unwrap_or_default())
            }
        }
    }

    pub async fn update_account_settings(
        &self,
        account_id: &str,
        settings: &AccountSettings,
        updated_at: i64,
    ) -> Result<(), StorageError> {
        let value_json = serde_json::to_string(settings)
            .map_err(|error| StorageError::InvalidEvent(error.to_string()))?;
        match &self.backend {
            StorageBackend::Sqlite(storage) => storage
                .lock()
                .map_err(|_| StorageError::LockPoisoned)?
                .update_account_settings(account_id, settings, updated_at)
                .map_err(Into::into),
            StorageBackend::Postgres(pool) => {
                sqlx::query("INSERT INTO account_settings (account_id, value_json, updated_at) VALUES ($1, $2, $3) ON CONFLICT(account_id) DO UPDATE SET value_json = EXCLUDED.value_json, updated_at = EXCLUDED.updated_at")
                    .bind(account_id)
                    .bind(value_json)
                    .bind(updated_at)
                    .execute(pool)
                    .await?;
                Ok(())
            }
        }
    }

    pub async fn update_account_folders(
        &self,
        account_id: &str,
        folders: &[StoredFolder],
        updated_at: i64,
    ) -> Result<(), StorageError> {
        let folders_json = serde_json::to_string(folders)
            .map_err(|error| StorageError::InvalidEvent(error.to_string()))?;
        match &self.backend {
            StorageBackend::Sqlite(storage) => storage
                .lock()
                .map_err(|_| StorageError::LockPoisoned)?
                .update_account_folders(account_id, folders, updated_at)
                .map_err(Into::into),
            StorageBackend::Postgres(pool) => {
                sqlx::query("INSERT INTO account_folders (account_id, folders_json, updated_at) VALUES ($1, $2, $3) ON CONFLICT(account_id) DO UPDATE SET folders_json = EXCLUDED.folders_json, updated_at = EXCLUDED.updated_at")
                    .bind(account_id)
                    .bind(folders_json)
                    .bind(updated_at)
                    .execute(pool)
                    .await?;
                Ok(())
            }
        }
    }

    pub async fn update_account_name(
        &self,
        account_id: &str,
        name: &str,
    ) -> Result<bool, StorageError> {
        match &self.backend {
            StorageBackend::Sqlite(storage) => storage
                .lock()
                .map_err(|_| StorageError::LockPoisoned)?
                .update_account_name(account_id, name)
                .map_err(Into::into),
            StorageBackend::Postgres(pool) => {
                Ok(sqlx::query("UPDATE accounts SET name = $1 WHERE id = $2")
                    .bind(name)
                    .bind(account_id)
                    .execute(pool)
                    .await?
                    .rows_affected()
                    > 0)
            }
        }
    }

    pub async fn change_password(
        &self,
        account_id: &str,
        password_hash: &str,
    ) -> Result<bool, StorageError> {
        match &self.backend {
            StorageBackend::Sqlite(storage) => storage
                .lock()
                .map_err(|_| StorageError::LockPoisoned)?
                .change_password(account_id, password_hash)
                .map_err(Into::into),
            StorageBackend::Postgres(pool) => Ok(sqlx::query(
                "UPDATE accounts SET password_hash = $1 WHERE id = $2",
            )
            .bind(password_hash)
            .bind(account_id)
            .execute(pool)
            .await?
            .rows_affected()
                > 0),
        }
    }

    pub async fn store_session_with_metadata(
        &self,
        token: &str,
        account_id: &str,
        created_at: i64,
        device_id: Option<&str>,
        platform: Option<&str>,
        device_name: Option<&str>,
        app_version: Option<&str>,
    ) -> Result<String, StorageError> {
        match &self.backend {
            StorageBackend::Sqlite(storage) => storage
                .lock()
                .map_err(|_| StorageError::LockPoisoned)?
                .store_session_with_metadata(
                    token,
                    account_id,
                    created_at,
                    device_id,
                    platform,
                    device_name,
                    app_version,
                )
                .map_err(Into::into),
            StorageBackend::Postgres(pool) => {
                let session_id = Uuid::new_v4().to_string();
                sqlx::query("INSERT INTO sessions (token, account_id, created_at, expires_at, session_id, device_id, platform, device_name, app_version, last_seen_at) VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, 'unknown'), $8, $9, $3) ON CONFLICT (token) DO UPDATE SET account_id = EXCLUDED.account_id, created_at = EXCLUDED.created_at, expires_at = EXCLUDED.expires_at, session_id = EXCLUDED.session_id, device_id = EXCLUDED.device_id, platform = EXCLUDED.platform, device_name = EXCLUDED.device_name, app_version = EXCLUDED.app_version, last_seen_at = EXCLUDED.last_seen_at").bind(token).bind(account_id).bind(created_at).bind(created_at.saturating_add(SESSION_TTL_MS)).bind(&session_id).bind(device_id).bind(platform).bind(device_name).bind(app_version).execute(pool).await?;
                Ok(session_id)
            }
        }
    }

    pub async fn list_sessions(
        &self,
        account_id: &str,
        current_token: &str,
        now: i64,
    ) -> Result<Vec<StoredSession>, StorageError> {
        match &self.backend {
            StorageBackend::Sqlite(storage) => storage
                .lock()
                .map_err(|_| StorageError::LockPoisoned)?
                .list_sessions(account_id, current_token, now)
                .map_err(Into::into),
            StorageBackend::Postgres(pool) => {
                let rows = sqlx::query("SELECT token, session_id, device_id, platform, device_name, app_version, created_at, expires_at, last_seen_at FROM sessions WHERE account_id = $1 AND expires_at > $2 ORDER BY COALESCE(last_seen_at, created_at) DESC")
                    .bind(account_id)
                    .bind(now)
                    .fetch_all(pool)
                    .await?;
                let mut result = Vec::with_capacity(rows.len());
                for row in rows {
                    let token: String = row.try_get("token")?;
                    let stored_id = row.try_get::<Option<String>, _>("session_id")?;
                    let id = stored_id
                        .as_deref()
                        .filter(|value| !value.is_empty())
                        .map(str::to_owned)
                        .unwrap_or_else(|| legacy_session_id(&token));
                    if stored_id.as_deref().is_none_or(str::is_empty) {
                        sqlx::query("UPDATE sessions SET session_id = $1 WHERE token = $2 AND (session_id IS NULL OR session_id = '')")
                            .bind(&id)
                            .bind(&token)
                            .execute(pool)
                            .await?;
                    }
                    result.push(StoredSession {
                        id,
                        device_id: row.try_get("device_id")?,
                        platform: row.try_get("platform")?,
                        device_name: row.try_get("device_name")?,
                        app_version: row.try_get("app_version")?,
                        created_at: row.try_get("created_at")?,
                        expires_at: row.try_get("expires_at")?,
                        last_seen_at: row.try_get("last_seen_at")?,
                        current: token == current_token,
                    });
                }
                Ok(result)
            }
        }
    }

    pub async fn revoke_session_by_id(
        &self,
        account_id: &str,
        session_id: &str,
    ) -> Result<bool, StorageError> {
        match &self.backend {
            StorageBackend::Sqlite(storage) => storage
                .lock()
                .map_err(|_| StorageError::LockPoisoned)?
                .revoke_session_by_id(account_id, session_id)
                .map_err(Into::into),
            StorageBackend::Postgres(pool) => Ok(sqlx::query(
                "DELETE FROM sessions WHERE account_id = $1 AND session_id = $2",
            )
            .bind(account_id)
            .bind(session_id)
            .execute(pool)
            .await?
            .rows_affected()
                > 0),
        }
    }

    pub async fn revoke_other_sessions(
        &self,
        account_id: &str,
        current_token: &str,
    ) -> Result<u64, StorageError> {
        match &self.backend {
            StorageBackend::Sqlite(storage) => storage
                .lock()
                .map_err(|_| StorageError::LockPoisoned)?
                .revoke_other_sessions(account_id, current_token)
                .map_err(Into::into),
            StorageBackend::Postgres(pool) => Ok(sqlx::query(
                "DELETE FROM sessions WHERE account_id = $1 AND token <> $2",
            )
            .bind(account_id)
            .bind(current_token)
            .execute(pool)
            .await?
            .rows_affected()),
        }
    }

    pub async fn bind_session_device(
        &self,
        account_id: &str,
        token: &str,
        device_id: &str,
    ) -> Result<bool, StorageError> {
        match &self.backend {
            StorageBackend::Sqlite(storage) => storage
                .lock()
                .map_err(|_| StorageError::LockPoisoned)?
                .bind_session_device(account_id, token, device_id)
                .map_err(Into::into),
            StorageBackend::Postgres(pool) => Ok(sqlx::query(
                "UPDATE sessions SET device_id = $1 WHERE account_id = $2 AND token = $3 AND (device_id IS NULL OR device_id = $1)",
            )
            .bind(device_id)
            .bind(account_id)
            .bind(token)
            .execute(pool)
            .await?
            .rows_affected()
                > 0),
        }
    }

    pub async fn update_session_metadata(
        &self,
        account_id: &str,
        token: &str,
        platform: Option<&str>,
        device_name: Option<&str>,
        app_version: Option<&str>,
        now: i64,
    ) -> Result<bool, StorageError> {
        match &self.backend {
            StorageBackend::Sqlite(storage) => storage
                .lock()
                .map_err(|_| StorageError::LockPoisoned)?
                .update_session_metadata(account_id, token, platform, device_name, app_version, now)
                .map_err(Into::into),
            StorageBackend::Postgres(pool) => Ok(sqlx::query(
                "UPDATE sessions SET platform = COALESCE(NULLIF($3, ''), platform), device_name = COALESCE(NULLIF($4, ''), device_name), app_version = COALESCE(NULLIF($5, ''), app_version), last_seen_at = $6 WHERE account_id = $1 AND token = $2 AND expires_at > $6",
            )
            .bind(account_id)
            .bind(token)
            .bind(platform)
            .bind(device_name)
            .bind(app_version)
            .bind(now)
            .execute(pool)
            .await?
            .rows_affected()
                > 0),
        }
    }

    pub async fn upsert_device(
        &self,
        account_id: &str,
        device_id: &str,
        platform: &str,
        name: Option<&str>,
        app_version: Option<&str>,
        now: i64,
    ) -> Result<(), StorageError> {
        match &self.backend {
            StorageBackend::Sqlite(storage) => storage
                .lock()
                .map_err(|_| StorageError::LockPoisoned)?
                .upsert_device(account_id, device_id, platform, name, app_version, now)
                .map_err(Into::into),
            StorageBackend::Postgres(pool) => {
                sqlx::query("INSERT INTO devices (owner_account_id, device_id, platform, name, app_version, created_at, last_seen_at) VALUES ($1, $2, $3, $4, $5, $6, $6) ON CONFLICT(owner_account_id, device_id) DO UPDATE SET platform = COALESCE(NULLIF(EXCLUDED.platform, 'unknown'), devices.platform), name = COALESCE(EXCLUDED.name, devices.name), app_version = COALESCE(EXCLUDED.app_version, devices.app_version), last_seen_at = EXCLUDED.last_seen_at, revoked_at = NULL")
                    .bind(account_id)
                    .bind(device_id)
                    .bind(platform)
                    .bind(name)
                    .bind(app_version)
                    .bind(now)
                    .execute(pool)
                    .await?;
                Ok(())
            }
        }
    }

    pub async fn list_devices(&self, account_id: &str) -> Result<Vec<StoredDevice>, StorageError> {
        match &self.backend {
            StorageBackend::Sqlite(storage) => storage
                .lock()
                .map_err(|_| StorageError::LockPoisoned)?
                .list_devices(account_id)
                .map_err(Into::into),
            StorageBackend::Postgres(pool) => {
                let rows = sqlx::query("SELECT device_id, platform, name, app_version, created_at, last_seen_at, revoked_at FROM devices WHERE owner_account_id = $1 ORDER BY COALESCE(last_seen_at, created_at) DESC")
                    .bind(account_id)
                    .fetch_all(pool)
                    .await?;
                rows.into_iter()
                    .map(|row| {
                        Ok(StoredDevice {
                            device_id: row.try_get("device_id")?,
                            platform: row.try_get("platform")?,
                            name: row.try_get("name")?,
                            app_version: row.try_get("app_version")?,
                            created_at: row.try_get("created_at")?,
                            last_seen_at: row.try_get("last_seen_at")?,
                            revoked_at: row.try_get("revoked_at")?,
                        })
                    })
                    .collect::<Result<Vec<_>, sqlx::Error>>()
                    .map_err(Into::into)
            }
        }
    }

    pub async fn revoke_device(
        &self,
        account_id: &str,
        device_id: &str,
        now: i64,
    ) -> Result<bool, StorageError> {
        match &self.backend {
            StorageBackend::Sqlite(storage) => storage
                .lock()
                .map_err(|_| StorageError::LockPoisoned)?
                .revoke_device(account_id, device_id, now)
                .map_err(Into::into),
            StorageBackend::Postgres(pool) => {
                let mut transaction = pool.begin().await?;
                let changed = sqlx::query("UPDATE devices SET revoked_at = $1 WHERE owner_account_id = $2 AND device_id = $3 AND revoked_at IS NULL")
                    .bind(now)
                    .bind(account_id)
                    .bind(device_id)
                    .execute(&mut *transaction)
                    .await?
                    .rows_affected();
                sqlx::query(
                    "DELETE FROM device_keys WHERE owner_account_id = $1 AND device_id = $2",
                )
                .bind(account_id)
                .bind(device_id)
                .execute(&mut *transaction)
                .await?;
                sqlx::query(
                    "DELETE FROM push_tokens WHERE owner_account_id = $1 AND device_id = $2",
                )
                .bind(account_id)
                .bind(device_id)
                .execute(&mut *transaction)
                .await?;
                sqlx::query("DELETE FROM sessions WHERE account_id = $1 AND device_id = $2")
                    .bind(account_id)
                    .bind(device_id)
                    .execute(&mut *transaction)
                    .await?;
                transaction.commit().await?;
                Ok(changed > 0)
            }
        }
    }

    pub async fn account_id_for_session(
        &self,
        token: &str,
        now: i64,
    ) -> Result<Option<String>, StorageError> {
        match &self.backend {
            StorageBackend::Sqlite(storage) => storage
                .lock()
                .map_err(|_| StorageError::LockPoisoned)?
                .account_id_for_session(token, now)
                .map_err(Into::into),
            StorageBackend::Postgres(pool) => Ok(sqlx::query(
                "SELECT account_id FROM sessions WHERE token = $1 AND expires_at > $2",
            )
            .bind(token)
            .bind(now)
            .fetch_optional(pool)
            .await?
            .map(|row| row.try_get("account_id"))
            .transpose()?),
        }
    }

    pub async fn revoke_session(&self, token: &str) -> Result<bool, StorageError> {
        match &self.backend {
            StorageBackend::Sqlite(storage) => storage
                .lock()
                .map_err(|_| StorageError::LockPoisoned)?
                .revoke_session(token)
                .map_err(Into::into),
            StorageBackend::Postgres(pool) => {
                Ok(sqlx::query("DELETE FROM sessions WHERE token = $1")
                    .bind(token)
                    .execute(pool)
                    .await?
                    .rows_affected()
                    > 0)
            }
        }
    }

    pub async fn register_push_token(
        &self,
        account_id: &str,
        device_id: &str,
        token: &str,
        platform: &str,
        updated_at: i64,
    ) -> Result<(), StorageError> {
        match &self.backend {
            StorageBackend::Sqlite(storage) => storage
                .lock()
                .map_err(|_| StorageError::LockPoisoned)?
                .register_push_token(account_id, device_id, token, platform, updated_at)
                .map_err(Into::into),
            StorageBackend::Postgres(pool) => {
                sqlx::query("DELETE FROM push_tokens WHERE token = $1 AND NOT (owner_account_id = $2 AND device_id = $3)")
                    .bind(token)
                    .bind(account_id)
                    .bind(device_id)
                    .execute(pool)
                    .await?;
                sqlx::query(
                    "INSERT INTO push_tokens (owner_account_id, device_id, token, platform, created_at, updated_at)
                     VALUES ($1, $2, $3, $4, $5, $5)
                     ON CONFLICT (owner_account_id, device_id) DO UPDATE SET token = EXCLUDED.token, platform = EXCLUDED.platform, updated_at = EXCLUDED.updated_at",
                )
                .bind(account_id)
                .bind(device_id)
                .bind(token)
                .bind(platform)
                .bind(updated_at)
                .execute(pool)
                .await?;
                Ok(())
            }
        }
    }

    pub async fn push_tokens(&self, account_id: &str) -> Result<Vec<String>, StorageError> {
        match &self.backend {
            StorageBackend::Sqlite(storage) => storage
                .lock()
                .map_err(|_| StorageError::LockPoisoned)?
                .push_tokens(account_id)
                .map_err(Into::into),
            StorageBackend::Postgres(pool) => {
                let rows = sqlx::query("SELECT token FROM push_tokens WHERE owner_account_id = $1")
                    .bind(account_id)
                    .fetch_all(pool)
                    .await?;
                rows.into_iter()
                    .map(|row| row.try_get("token"))
                    .collect::<Result<Vec<String>, sqlx::Error>>()
                    .map_err(Into::into)
            }
        }
    }

    pub async fn touch_presence(&self, account_id: &str, now: i64) -> Result<(), StorageError> {
        match &self.backend {
            StorageBackend::Sqlite(storage) => storage
                .lock()
                .map_err(|_| StorageError::LockPoisoned)?
                .touch_presence(account_id, now)
                .map_err(Into::into),
            StorageBackend::Postgres(pool) => {
                sqlx::query("UPDATE accounts SET last_seen_at = $1 WHERE id = $2")
                    .bind(now)
                    .bind(account_id)
                    .execute(pool)
                    .await?;
                Ok(())
            }
        }
    }

    pub async fn presence_watchers(
        &self,
        account_id: &str,
        local_server: &str,
    ) -> Result<Vec<PresenceWatcher>, StorageError> {
        let local_server = canonical_server(local_server);
        match &self.backend {
            StorageBackend::Sqlite(storage) => storage
                .lock()
                .map_err(|_| StorageError::LockPoisoned)?
                .presence_watchers(account_id, &local_server)
                .map_err(Into::into),
            StorageBackend::Postgres(pool) => {
                let rows = sqlx::query(
                    "SELECT c.owner_account_id, c.id
                     FROM conversations c
                     JOIN accounts peer ON peer.id = $1
                        AND peer.handle = CASE
                            WHEN POSITION('@' IN c.handle) > 0 THEN split_part(c.handle, '@', 1)
                            ELSE c.handle
                        END
                        AND split_part(c.handle, '@', 2) = $2
                     WHERE c.owner_account_id <> $1",
                )
                .bind(account_id)
                .bind(local_server)
                .fetch_all(pool)
                .await?;
                rows.into_iter()
                    .map(|row| {
                        Ok(PresenceWatcher {
                            owner_account_id: row.try_get("owner_account_id")?,
                            conversation_id: row.try_get("id")?,
                        })
                    })
                    .collect::<Result<Vec<_>, sqlx::Error>>()
                    .map_err(Into::into)
            }
        }
    }

    async fn events_since_limited(
        &self,
        account_id: &str,
        since: i64,
        limit: i64,
    ) -> Result<Vec<StoredEvent>, StorageError> {
        match &self.backend {
            StorageBackend::Sqlite(storage) => storage
                .lock()
                .map_err(|_| StorageError::LockPoisoned)?
                .events_since_limited(account_id, since, limit)
                .map_err(Into::into),
            StorageBackend::Postgres(pool) => {
                let rows = sqlx::query(
                    "SELECT cursor, kind, payload_json FROM realtime_events
                     WHERE account_id = $1 AND cursor > $2 ORDER BY cursor ASC LIMIT $3",
                )
                .bind(account_id)
                .bind(since.max(0))
                .bind(limit)
                .fetch_all(pool)
                .await?;
                rows.into_iter()
                    .map(|row| {
                        decode_postgres_event(
                            account_id,
                            row.try_get("cursor")?,
                            row.try_get::<String, _>("kind")?.as_str(),
                            row.try_get::<String, _>("payload_json")?.as_str(),
                        )
                    })
                    .collect()
            }
        }
    }

    pub async fn event_for_message(
        &self,
        account_id: &str,
        message_id: &str,
    ) -> Result<Option<StoredEvent>, StorageError> {
        match &self.backend {
            StorageBackend::Sqlite(storage) => storage
                .lock()
                .map_err(|_| StorageError::LockPoisoned)?
                .event_for_message(account_id, message_id)
                .map_err(Into::into),
            StorageBackend::Postgres(pool) => {
                let Some(row) = sqlx::query(
                    "SELECT cursor, payload_json FROM realtime_events
                     WHERE account_id = $1 AND kind = 'message' AND source_id = $2",
                )
                .bind(account_id)
                .bind(message_id)
                .fetch_optional(pool)
                .await?
                else {
                    return Ok(None);
                };
                Ok(Some(decode_postgres_event(
                    account_id,
                    row.try_get("cursor")?,
                    "message",
                    row.try_get::<String, _>("payload_json")?.as_str(),
                )?))
            }
        }
    }

    pub async fn delivery_receipt(
        &self,
        message_id: &str,
        recipient_account_id: &str,
    ) -> Result<Option<i64>, StorageError> {
        match &self.backend {
            StorageBackend::Sqlite(storage) => storage
                .lock()
                .map_err(|_| StorageError::LockPoisoned)?
                .delivery_receipt(message_id, recipient_account_id)
                .map_err(Into::into),
            StorageBackend::Postgres(pool) => Ok(sqlx::query(
                "SELECT delivered_at FROM message_delivery_receipts
                 WHERE message_id = $1 AND recipient_account_id = $2",
            )
            .bind(message_id)
            .bind(recipient_account_id)
            .fetch_optional(pool)
            .await?
            .map(|row| row.try_get("delivered_at"))
            .transpose()?),
        }
    }

    pub async fn sync(
        &self,
        account_id: &str,
        since: i64,
        local_server: &str,
    ) -> Result<SyncSnapshot, StorageError> {
        let local_server = canonical_server(local_server);
        match &self.backend {
            StorageBackend::Sqlite(storage) => storage
                .lock()
                .map_err(|_| StorageError::LockPoisoned)?
                .sync(account_id, since, &local_server)
                .map_err(Into::into),
            StorageBackend::Postgres(pool) => {
                let conversations = sqlx::query(
                    "SELECT c.id, c.name, c.handle, c.avatar, c.subtitle, c.can_write, c.last_message, c.last_message_at, c.pinned, c.online,
                            peer.last_seen_at,
                            COALESCE((SELECT COUNT(DISTINCT COALESCE((unread_messages.message_json::jsonb ->> 'message_id'), unread_messages.id))
                                      FROM messages unread_messages
                                      LEFT JOIN conversation_reads unread_reads
                                        ON unread_reads.owner_account_id = unread_messages.owner_account_id
                                       AND unread_reads.conversation_id = unread_messages.conversation_id
                                      WHERE unread_messages.owner_account_id = c.owner_account_id
                                       AND unread_messages.conversation_id = c.id
                                       AND unread_messages.author = 'them'
                                       AND unread_messages.message_json <> ''
                                       AND unread_messages.created_at > COALESCE(unread_reads.read_at, 0)), 0) AS unread
                     FROM conversations c
                     LEFT JOIN accounts peer ON peer.handle = CASE
                         WHEN POSITION('@' IN c.handle) > 0 THEN split_part(c.handle, '@', 1)
                         ELSE c.handle
                     END
                     AND split_part(c.handle, '@', 2) = $2
                     WHERE c.owner_account_id = $1
                     ORDER BY c.pinned DESC, c.sort_order ASC, c.created_at ASC",
                )
                .bind(account_id)
                .bind(local_server)
                .fetch_all(pool)
                .await?
                .into_iter()
                .map(|row| {
                    Ok(StoredConversation {
                        id: row.try_get("id")?,
                        name: row.try_get("name")?,
                        handle: row.try_get("handle")?,
                        avatar: row.try_get("avatar")?,
                        subtitle: row.try_get("subtitle")?,
                        can_write: row.try_get("can_write")?,
                        last_message: row.try_get("last_message")?,
                        last_message_at: row.try_get("last_message_at")?,
                        pinned: row.try_get("pinned")?,
                        online: row.try_get("online")?,
                        last_seen_at: row.try_get("last_seen_at")?,
                        unread: row.try_get("unread")?,
                    })
                })
                .collect::<Result<Vec<_>, sqlx::Error>>()?;
                let folders = sqlx::query(
                    "SELECT folders_json FROM account_folders WHERE account_id = $1",
                )
                .bind(account_id)
                .fetch_optional(pool)
                .await?
                .and_then(|row| row.try_get::<String, _>("folders_json").ok())
                .and_then(|value| serde_json::from_str(&value).ok())
                .unwrap_or_default();
                let mut messages = Vec::new();
                let mut read_receipts = Vec::new();
                let mut delivery_receipts = Vec::new();
                let events = self
                    .events_since_limited(account_id, since, MAX_SYNC_EVENTS)
                    .await?;
                let cursor = events
                    .last()
                    .map(StoredEvent::cursor)
                    .unwrap_or(self.cursor(account_id).await?);
                for event in events {
                    match event {
                        StoredEvent::Message { message, .. } => messages.push(message),
                        StoredEvent::ReadReceipt {
                            message_id,
                            read_at,
                            ..
                        } => read_receipts.push(StoredReadReceipt {
                            message_id,
                            read_at,
                        }),
                        StoredEvent::DeliveryReceipt {
                            message_id,
                            delivered_at,
                            ..
                        } => delivery_receipts.push(StoredDeliveryReceipt {
                            message_id,
                            delivered_at,
                        }),
                    }
                }
                Ok(SyncSnapshot {
                    cursor,
                    conversations,
                    folders,
                    messages,
                    read_receipts,
                    delivery_receipts,
                })
            }
        }
    }

    pub async fn cursor(&self, account_id: &str) -> Result<i64, StorageError> {
        match &self.backend {
            StorageBackend::Sqlite(storage) => storage
                .lock()
                .map_err(|_| StorageError::LockPoisoned)?
                .cursor(account_id)
                .map_err(Into::into),
            StorageBackend::Postgres(pool) => Ok(sqlx::query(
                "SELECT COALESCE(cursor, 0) AS cursor FROM realtime_event_cursors WHERE account_id = $1",
            )
            .bind(account_id)
            .fetch_one(pool)
            .await?
            .try_get("cursor")?),
        }
    }

    pub async fn mark_conversation_read(
        &self,
        account_id: &str,
        conversation_id: &str,
        read_at: i64,
    ) -> Result<Option<Vec<StoredEvent>>, StorageError> {
        match &self.backend {
            StorageBackend::Sqlite(storage) => storage
                .lock()
                .map_err(|_| StorageError::LockPoisoned)?
                .mark_conversation_read(account_id, conversation_id, read_at)
                .map_err(Into::into),
            StorageBackend::Postgres(pool) => {
                let mut transaction = pool.begin().await?;
                let exists = sqlx::query(
                    "SELECT 1 FROM conversations WHERE owner_account_id = $1 AND id = $2",
                )
                .bind(account_id)
                .bind(conversation_id)
                .fetch_optional(&mut *transaction)
                .await?
                .is_some();
                if !exists {
                    transaction.commit().await?;
                    return Ok(None);
                }
                sqlx::query(
                    "INSERT INTO conversation_reads (owner_account_id, conversation_id, read_at)
                     VALUES ($1, $2, $3)
                     ON CONFLICT (owner_account_id, conversation_id) DO UPDATE SET read_at = GREATEST(conversation_reads.read_at, EXCLUDED.read_at)",
                )
                .bind(account_id)
                .bind(conversation_id)
                .bind(read_at)
                .execute(&mut *transaction)
                .await?;
                let encrypted_messages = sqlx::query(
                    "SELECT message_json FROM messages
                     WHERE owner_account_id = $1 AND conversation_id = $2 AND author = 'them' AND created_at <= $3 AND message_json <> ''",
                )
                .bind(account_id)
                .bind(conversation_id)
                .bind(read_at)
                .fetch_all(&mut *transaction)
                .await?;
                let mut message_ids = Vec::new();
                let mut events = Vec::new();
                for row in encrypted_messages {
                    let message_json: String = row.try_get("message_json")?;
                    let Some(message_id) = message_id_from_json(&message_json) else {
                        continue;
                    };
                    if message_ids.iter().any(|value| value == &message_id) {
                        continue;
                    }
                    message_ids.push(message_id.clone());
                    let changed = sqlx::query(
                        "INSERT INTO message_read_receipts (message_id, reader_account_id, read_at)
                         VALUES ($1, $2, $3)
                         ON CONFLICT (message_id, reader_account_id) DO UPDATE SET read_at = GREATEST(message_read_receipts.read_at, EXCLUDED.read_at)
                         WHERE EXCLUDED.read_at > message_read_receipts.read_at",
                    )
                    .bind(&message_id)
                    .bind(account_id)
                    .bind(read_at)
                    .execute(&mut *transaction)
                    .await?
                    .rows_affected();
                    if changed == 0 {
                        continue;
                    }
                    let Some(sender_account_id) = sqlx::query(
                        "SELECT owner_account_id FROM messages WHERE id = $1 AND author = 'me' LIMIT 1",
                    )
                    .bind(&message_id)
                    .fetch_optional(&mut *transaction)
                    .await?
                    .map(|row| row.try_get::<String, _>("owner_account_id"))
                    .transpose()?
                    else {
                        continue;
                    };
                    let cursor = append_postgres_receipt_event(
                        &mut transaction,
                        &sender_account_id,
                        "readReceipt",
                        &message_id,
                        read_at,
                    )
                    .await?;
                    events.push(StoredEvent::ReadReceipt {
                        account_id: sender_account_id,
                        cursor,
                        message_id,
                        read_at,
                    });
                }
                transaction.commit().await?;
                Ok(Some(events))
            }
        }
    }

    pub async fn can_write(
        &self,
        account_id: &str,
        conversation_id: &str,
    ) -> Result<Option<bool>, StorageError> {
        match &self.backend {
            StorageBackend::Sqlite(storage) => storage
                .lock()
                .map_err(|_| StorageError::LockPoisoned)?
                .can_write(account_id, conversation_id)
                .map_err(Into::into),
            StorageBackend::Postgres(pool) => Ok(sqlx::query(
                "SELECT can_write FROM conversations WHERE owner_account_id = $1 AND id = $2",
            )
            .bind(account_id)
            .bind(conversation_id)
            .fetch_optional(pool)
            .await?
            .map(|row| row.try_get("can_write"))
            .transpose()?),
        }
    }

    pub async fn store_media(
        &self,
        owner_account_id: &str,
        recipient_account_id: &str,
        conversation_id: &str,
        media_id: &str,
        ciphertext: &[u8],
        created_at: i64,
    ) -> Result<bool, StorageError> {
        match &self.backend {
            StorageBackend::Sqlite(storage) => storage
                .lock()
                .map_err(|_| StorageError::LockPoisoned)?
                .store_media(owner_account_id, recipient_account_id, conversation_id, media_id, ciphertext, created_at)
                .map_err(Into::into),
            StorageBackend::Postgres(pool) => Ok(sqlx::query(
                "INSERT INTO media_objects (id, owner_account_id, recipient_account_id, conversation_id, ciphertext, byte_size, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING",
            )
            .bind(media_id)
            .bind(owner_account_id)
            .bind(recipient_account_id)
            .bind(conversation_id)
            .bind(ciphertext)
            .bind(ciphertext.len() as i64)
            .bind(created_at)
            .execute(pool)
            .await?
            .rows_affected() > 0),
        }
    }

    pub async fn media_bytes(
        &self,
        account_id: &str,
        media_id: &str,
    ) -> Result<Option<Vec<u8>>, StorageError> {
        match &self.backend {
            StorageBackend::Sqlite(storage) => storage
                .lock()
                .map_err(|_| StorageError::LockPoisoned)?
                .media_bytes(account_id, media_id)
                .map_err(Into::into),
            StorageBackend::Postgres(pool) => Ok(sqlx::query(
                "SELECT ciphertext FROM media_objects WHERE id = $1 AND (owner_account_id = $2 OR recipient_account_id = $2)",
            )
            .bind(media_id)
            .bind(account_id)
            .fetch_optional(pool)
            .await?
            .map(|row| row.try_get("ciphertext"))
            .transpose()?),
        }
    }

    pub async fn create_direct_conversation(
        &self,
        account_id: &str,
        handle: &str,
        name: &str,
        avatar: &str,
        subtitle: Option<&str>,
        now: i64,
    ) -> Result<StoredConversation, StorageError> {
        match &self.backend {
            StorageBackend::Sqlite(storage) => storage
                .lock()
                .map_err(|_| StorageError::LockPoisoned)?
                .create_direct_conversation(account_id, handle, name, avatar, subtitle, now)
                .map_err(Into::into),
            StorageBackend::Postgres(pool) => {
                let mut transaction = pool.begin().await?;
                sqlx::query(
                    "INSERT INTO conversations (id, owner_account_id, name, handle, avatar, subtitle, can_write, last_message, pinned, online, sort_order, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, TRUE, '', FALSE, FALSE, 10, $7, $7) ON CONFLICT DO NOTHING",
                )
                .bind(format!("direct:{}", Uuid::new_v4()))
                .bind(account_id)
                .bind(name)
                .bind(handle)
                .bind(avatar)
                .bind(subtitle)
                .bind(now)
                .execute(&mut *transaction)
                .await?;
                let row = sqlx::query(
                    "SELECT id, name, handle, avatar, subtitle, can_write, last_message, last_message_at, pinned, online FROM conversations WHERE owner_account_id = $1 AND handle = $2",
                )
                .bind(account_id)
                .bind(handle)
                .fetch_one(&mut *transaction)
                .await?;
                transaction.commit().await?;
                Ok(StoredConversation {
                    id: row.try_get("id")?,
                    name: row.try_get("name")?,
                    handle: row.try_get("handle")?,
                    avatar: row.try_get("avatar")?,
                    subtitle: row.try_get("subtitle")?,
                    can_write: row.try_get("can_write")?,
                    last_message: row.try_get("last_message")?,
                    last_message_at: row.try_get("last_message_at")?,
                    pinned: row.try_get("pinned")?,
                    online: row.try_get("online")?,
                    last_seen_at: None,
                    unread: 0,
                })
            }
        }
    }

    pub async fn insert_message(
        &self,
        account_id: &str,
        conversation_id: &str,
        client_message_id: &str,
        message_json: &str,
        created_at: i64,
    ) -> Result<Option<StoredMessage>, StorageError> {
        match &self.backend {
            StorageBackend::Sqlite(storage) => storage
                .lock()
                .map_err(|_| StorageError::LockPoisoned)?
                .insert_message(
                    account_id,
                    conversation_id,
                    client_message_id,
                    message_json,
                    created_at,
                )
                .map_err(Into::into),
            StorageBackend::Postgres(pool) => {
                let mut transaction = pool.begin().await?;
                let Some(can_write) = sqlx::query(
                    "SELECT can_write FROM conversations WHERE owner_account_id = $1 AND id = $2",
                )
                .bind(account_id)
                .bind(conversation_id)
                .fetch_optional(&mut *transaction)
                .await?
                .map(|row| row.try_get::<bool, _>("can_write"))
                .transpose()?
                else {
                    return Ok(None);
                };
                if !can_write {
                    return Ok(None);
                }
                if let Some(row) = sqlx::query(
                    "SELECT id, conversation_id, author, created_at, stack_id, message_json FROM messages WHERE owner_account_id = $1 AND client_message_id = $2",
                )
                .bind(account_id)
                .bind(client_message_id)
                .fetch_optional(&mut *transaction)
                .await?
                {
                    transaction.commit().await?;
                    return Ok(Some(StoredMessage {
                        id: row.try_get("id")?,
                        conversation_id: row.try_get("conversation_id")?,
                        author: row.try_get("author")?,
                        created_at: row.try_get("created_at")?,
                        stack_id: row.try_get("stack_id")?,
                        message_json: row.try_get("message_json")?,
                    }));
                }
                let stack_id = message_stack_id(conversation_id, "me", created_at);
                sqlx::query(
                    "INSERT INTO messages (id, owner_account_id, conversation_id, author, text, message_json, created_at, stack_id, client_message_id) VALUES ($1, $2, $3, 'me', '', $4, $5, $6, $1)",
                )
                .bind(client_message_id)
                .bind(account_id)
                .bind(conversation_id)
                .bind(message_json)
                .bind(created_at)
                .bind(&stack_id)
                .execute(&mut *transaction)
                .await?;
                sqlx::query(
                    "UPDATE conversations SET last_message = '', last_message_at = $1, updated_at = $1 WHERE owner_account_id = $2 AND id = $3",
                )
                .bind(created_at)
                .bind(account_id)
                .bind(conversation_id)
                .execute(&mut *transaction)
                .await?;
                let message = StoredMessage {
                    id: client_message_id.to_owned(),
                    conversation_id: conversation_id.to_owned(),
                    author: "me".to_owned(),
                    created_at,
                    stack_id,
                    message_json: message_json.to_owned(),
                };
                append_postgres_message_event(&mut transaction, account_id, &message).await?;
                transaction.commit().await?;
                Ok(Some(message))
            }
        }
    }

    pub async fn add_device_message_copy(
        &self,
        account_id: &str,
        conversation_id: &str,
        message_id: &str,
        source_key_id: Option<&str>,
        target_key_id: &str,
        message_json: &str,
    ) -> Result<bool, StorageError> {
        match &self.backend {
            StorageBackend::Sqlite(storage) => storage
                .lock()
                .map_err(|_| StorageError::LockPoisoned)?
                .add_device_message_copy(
                    account_id,
                    conversation_id,
                    message_id,
                    source_key_id,
                    target_key_id,
                    message_json,
                )
                .map_err(Into::into),
            StorageBackend::Postgres(pool) => {
                let mut transaction = pool.begin().await?;
                let source_delivery_id = source_key_id
                    .filter(|value| !value.is_empty())
                    .map(|value| format!("{message_id}:{value}"));
                let source = sqlx::query(
                    "SELECT author, created_at FROM messages
                     WHERE owner_account_id = $1 AND conversation_id = $2
                       AND (id = $3 OR client_message_id = $4)
                     ORDER BY seq ASC LIMIT 1",
                )
                .bind(account_id)
                .bind(conversation_id)
                .bind(message_id)
                .bind(source_delivery_id)
                .fetch_optional(&mut *transaction)
                .await?;
                let Some(source) = source else {
                    transaction.commit().await?;
                    return Ok(false);
                };
                let author: String = source.try_get("author")?;
                let created_at: i64 = source.try_get("created_at")?;
                let copy_id = format!("device-copy:{account_id}:{message_id}:{target_key_id}");
                let stack_id = message_stack_id(conversation_id, &author, created_at);
                let result = sqlx::query(
                    "INSERT INTO messages (id, owner_account_id, conversation_id, author, text, message_json, created_at, stack_id, client_message_id)
                     VALUES ($1, $2, $3, $4, '', $5, $6, $7, $1) ON CONFLICT DO NOTHING",
                )
                .bind(&copy_id)
                .bind(account_id)
                .bind(conversation_id)
                .bind(&author)
                .bind(message_json)
                .bind(created_at)
                .bind(&stack_id)
                .execute(&mut *transaction)
                .await?;
                if result.rows_affected() > 0 {
                    append_postgres_message_event(
                        &mut transaction,
                        account_id,
                        &StoredMessage {
                            id: copy_id,
                            conversation_id: conversation_id.to_owned(),
                            author,
                            created_at,
                            stack_id,
                            message_json: message_json.to_owned(),
                        },
                    )
                    .await?;
                }
                transaction.commit().await?;
                Ok(result.rows_affected() > 0)
            }
        }
    }

    pub async fn deliver_message(
        &self,
        account_id: &str,
        conversation_id: &str,
        peer_address: &str,
        peer_name: &str,
        peer_avatar: &str,
        delivery_id: &str,
        message_json: &str,
        created_at: i64,
    ) -> Result<Option<StoredMessage>, StorageError> {
        match &self.backend {
            StorageBackend::Sqlite(storage) => storage
                .lock()
                .map_err(|_| StorageError::LockPoisoned)?
                .deliver_message(
                    account_id,
                    conversation_id,
                    peer_address,
                    peer_name,
                    peer_avatar,
                    delivery_id,
                    message_json,
                    created_at,
                )
                .map_err(Into::into),
            StorageBackend::Postgres(pool) => {
                let mut transaction = pool.begin().await?;
                if sqlx::query(
                    "SELECT 1 FROM messages WHERE owner_account_id = $1 AND client_message_id = $2",
                )
                .bind(account_id)
                .bind(delivery_id)
                .fetch_optional(&mut *transaction)
                .await?
                .is_some()
                {
                    transaction.commit().await?;
                    return Ok(None);
                }
                let target_conversation_id = sqlx::query(
                    "SELECT id FROM conversations WHERE owner_account_id = $1 AND handle = $2",
                )
                .bind(account_id)
                .bind(peer_address)
                .fetch_optional(&mut *transaction)
                .await?
                .map(|row| row.try_get::<String, _>("id"))
                .transpose()?;
                let target_conversation_id = if let Some(id) = target_conversation_id {
                    id
                } else {
                    let id = format!("direct:{}", Uuid::new_v4());
                    sqlx::query(
                        "INSERT INTO conversations (id, owner_account_id, name, handle, avatar, subtitle, can_write, last_message, pinned, online, sort_order, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $4, TRUE, '', FALSE, FALSE, 10, $6, $6) ON CONFLICT DO NOTHING",
                    )
                    .bind(&id)
                    .bind(account_id)
                    .bind(peer_name)
                    .bind(peer_address)
                    .bind(peer_avatar)
                    .bind(created_at)
                    .execute(&mut *transaction)
                    .await?;
                    id
                };
                let stored_id = format!("inbound:{account_id}:{delivery_id}");
                let stack_id = message_stack_id(&target_conversation_id, "them", created_at);
                let inserted = sqlx::query(
                    "INSERT INTO messages (id, owner_account_id, conversation_id, author, text, message_json, created_at, stack_id, client_message_id) VALUES ($1, $2, $3, 'them', '', $4, $5, $6, $7) ON CONFLICT DO NOTHING",
                )
                .bind(&stored_id)
                .bind(account_id)
                .bind(&target_conversation_id)
                .bind(message_json)
                .bind(created_at)
                .bind(&stack_id)
                .bind(delivery_id)
                .execute(&mut *transaction)
                .await?;
                if inserted.rows_affected() == 0 {
                    transaction.commit().await?;
                    return Ok(None);
                }
                sqlx::query(
                    "UPDATE conversations SET last_message = '', last_message_at = $1, updated_at = $1 WHERE owner_account_id = $2 AND id = $3",
                )
                .bind(created_at)
                .bind(account_id)
                .bind(&target_conversation_id)
                .execute(&mut *transaction)
                .await?;
                let message = StoredMessage {
                    id: stored_id,
                    conversation_id: target_conversation_id,
                    author: "them".to_owned(),
                    created_at,
                    stack_id,
                    message_json: message_json.to_owned(),
                };
                append_postgres_message_event(&mut transaction, account_id, &message).await?;
                transaction.commit().await?;
                Ok(Some(message))
            }
        }
    }

    pub async fn mark_message_delivered(
        &self,
        message_id: &str,
        recipient_account_id: &str,
        delivered_at: i64,
    ) -> Result<Option<StoredEvent>, StorageError> {
        match &self.backend {
            StorageBackend::Sqlite(storage) => storage
                .lock()
                .map_err(|_| StorageError::LockPoisoned)?
                .mark_message_delivered(message_id, recipient_account_id, delivered_at)
                .map_err(Into::into),
            StorageBackend::Postgres(pool) => {
                let mut transaction = pool.begin().await?;
                let Some(account_id) = sqlx::query(
                    "SELECT owner_account_id FROM messages WHERE id = $1 AND author = 'me' LIMIT 1",
                )
                .bind(message_id)
                .fetch_optional(&mut *transaction)
                .await?
                .map(|row| row.try_get::<String, _>("owner_account_id"))
                .transpose()?
                else {
                    transaction.commit().await?;
                    return Ok(None);
                };
                let recipient_has_copy = sqlx::query(
                    "SELECT 1 FROM messages
                     WHERE owner_account_id = $1 AND author = 'them' AND message_json <> ''
                       AND message_json::jsonb ->> 'message_id' = $2
                     LIMIT 1",
                )
                .bind(recipient_account_id)
                .bind(message_id)
                .fetch_optional(&mut *transaction)
                .await?
                .is_some();
                if !recipient_has_copy {
                    transaction.commit().await?;
                    return Ok(None);
                }
                let changed = sqlx::query(
                    "INSERT INTO message_delivery_receipts (message_id, recipient_account_id, delivered_at)
                     VALUES ($1, $2, $3)
                     ON CONFLICT (message_id, recipient_account_id) DO NOTHING",
                )
                .bind(message_id)
                .bind(recipient_account_id)
                .bind(delivered_at)
                .execute(&mut *transaction)
                .await?
                .rows_affected();
                let event = if changed == 0 {
                    None
                } else {
                    let cursor = append_postgres_receipt_event(
                        &mut transaction,
                        &account_id,
                        "deliveryReceipt",
                        message_id,
                        delivered_at,
                    )
                    .await?;
                    Some(StoredEvent::DeliveryReceipt {
                        account_id,
                        cursor,
                        message_id: message_id.to_owned(),
                        delivered_at,
                    })
                };
                transaction.commit().await?;
                Ok(event)
            }
        }
    }

    pub async fn register_device_key(
        &self,
        account_id: &str,
        key: &StoredDeviceKey,
        updated_at: i64,
    ) -> Result<(), StorageError> {
        match &self.backend {
            StorageBackend::Sqlite(storage) => storage
                .lock()
                .map_err(|_| StorageError::LockPoisoned)?
                .register_device_key(account_id, key, updated_at)
                .map_err(Into::into),
            StorageBackend::Postgres(pool) => {
                sqlx::query(
                    "INSERT INTO device_keys (owner_account_id, device_id, key_id, encryption_public_key, signing_public_key, created_at, updated_at)
                     VALUES ($1, $2, $3, $4, $5, $6, $7)
                     ON CONFLICT (owner_account_id, device_id) DO UPDATE SET key_id = EXCLUDED.key_id, encryption_public_key = EXCLUDED.encryption_public_key, signing_public_key = EXCLUDED.signing_public_key, updated_at = EXCLUDED.updated_at",
                )
                .bind(account_id)
                .bind(&key.device_id)
                .bind(&key.key_id)
                .bind(&key.encryption_public_key)
                .bind(&key.signing_public_key)
                .bind(key.created_at)
                .bind(updated_at)
                .execute(pool)
                .await?;
                Ok(())
            }
        }
    }

    pub async fn device_keys_for_handle(
        &self,
        handle: &str,
    ) -> Result<Option<Vec<StoredDeviceKey>>, StorageError> {
        match &self.backend {
            StorageBackend::Sqlite(storage) => storage
                .lock()
                .map_err(|_| StorageError::LockPoisoned)?
                .device_keys_for_handle(handle)
                .map_err(Into::into),
            StorageBackend::Postgres(pool) => {
                let keys = sqlx::query(
                    "SELECT device_id, key_id, encryption_public_key, signing_public_key, device_keys.created_at
                     FROM device_keys JOIN accounts ON accounts.id = device_keys.owner_account_id
                     WHERE accounts.handle = $1 ORDER BY device_keys.updated_at DESC",
                )
                .bind(handle)
                .fetch_all(pool)
                .await?
                .into_iter()
                .map(|row| {
                    Ok(StoredDeviceKey {
                        device_id: row.try_get("device_id")?,
                        key_id: row.try_get("key_id")?,
                        encryption_public_key: row.try_get("encryption_public_key")?,
                        signing_public_key: row.try_get("signing_public_key")?,
                        created_at: row.try_get("created_at")?,
                    })
                })
                .collect::<Result<Vec<_>, sqlx::Error>>()?;
                Ok((!keys.is_empty()).then_some(keys))
            }
        }
    }

    pub async fn has_device_key(
        &self,
        account_id: &str,
        device_id: &str,
    ) -> Result<bool, StorageError> {
        match &self.backend {
            StorageBackend::Sqlite(storage) => storage
                .lock()
                .map_err(|_| StorageError::LockPoisoned)?
                .has_device_key(account_id, device_id)
                .map_err(Into::into),
            StorageBackend::Postgres(pool) => Ok(sqlx::query(
                "SELECT EXISTS(SELECT 1 FROM device_keys WHERE owner_account_id = $1 AND device_id = $2) AS present",
            )
            .bind(account_id)
            .bind(device_id)
            .fetch_one(pool)
            .await?
            .try_get("present")?),
        }
    }

    pub async fn has_device_key_id(
        &self,
        account_id: &str,
        key_id: &str,
    ) -> Result<bool, StorageError> {
        match &self.backend {
            StorageBackend::Sqlite(storage) => storage
                .lock()
                .map_err(|_| StorageError::LockPoisoned)?
                .has_device_key_id(account_id, key_id)
                .map_err(Into::into),
            StorageBackend::Postgres(pool) => Ok(sqlx::query(
                "SELECT EXISTS(SELECT 1 FROM device_keys WHERE owner_account_id = $1 AND key_id = $2) AS present",
            )
            .bind(account_id)
            .bind(key_id)
            .fetch_one(pool)
            .await?
            .try_get("present")?),
        }
    }

    pub async fn register_account_key(
        &self,
        account_id: &str,
        key_id: &str,
        encryption_public_key: &str,
        updated_at: i64,
    ) -> Result<(), StorageError> {
        match &self.backend {
            StorageBackend::Sqlite(storage) => storage
                .lock()
                .map_err(|_| StorageError::LockPoisoned)?
                .register_account_key(account_id, key_id, encryption_public_key, updated_at)
                .map_err(Into::into),
            StorageBackend::Postgres(pool) => {
                sqlx::query(
                    "INSERT INTO account_keys (owner_account_id, key_id, encryption_public_key, created_at, updated_at)
                     VALUES ($1, $2, $3, $4, $5)
                     ON CONFLICT (owner_account_id) DO UPDATE SET key_id = EXCLUDED.key_id, encryption_public_key = EXCLUDED.encryption_public_key, updated_at = EXCLUDED.updated_at",
                )
                .bind(account_id)
                .bind(key_id)
                .bind(encryption_public_key)
                .bind(updated_at)
                .bind(updated_at)
                .execute(pool)
                .await?;
                Ok(())
            }
        }
    }

    pub async fn account_key_for_handle(
        &self,
        handle: &str,
    ) -> Result<Option<StoredAccountKey>, StorageError> {
        match &self.backend {
            StorageBackend::Sqlite(storage) => storage
                .lock()
                .map_err(|_| StorageError::LockPoisoned)?
                .account_key_for_handle(handle)
                .map_err(Into::into),
            StorageBackend::Postgres(pool) => {
                let row = sqlx::query(
                    "SELECT account_keys.key_id, account_keys.encryption_public_key
                     FROM account_keys JOIN accounts ON accounts.id = account_keys.owner_account_id
                     WHERE accounts.handle = $1",
                )
                .bind(handle)
                .fetch_optional(pool)
                .await?;
                row.map(|row| {
                    Ok(StoredAccountKey {
                        key_id: row.try_get("key_id")?,
                        encryption_public_key: row.try_get("encryption_public_key")?,
                    })
                })
                .transpose()
            }
        }
    }

    pub async fn has_account_key_id(
        &self,
        account_id: &str,
        key_id: &str,
    ) -> Result<bool, StorageError> {
        match &self.backend {
            StorageBackend::Sqlite(storage) => storage
                .lock()
                .map_err(|_| StorageError::LockPoisoned)?
                .has_account_key_id(account_id, key_id)
                .map_err(Into::into),
            StorageBackend::Postgres(pool) => Ok(sqlx::query(
                "SELECT EXISTS(SELECT 1 FROM account_keys WHERE owner_account_id = $1 AND key_id = $2) AS present",
            )
            .bind(account_id)
            .bind(key_id)
            .fetch_one(pool)
            .await?
            .try_get("present")?),
        }
    }
}

#[cfg(test)]
mod backend_tests {
    use super::*;

    #[tokio::test]
    async fn shared_storage_api_accepts_sqlite_url() {
        let storage = Storage::open("sqlite::memory:")
            .await
            .expect("open sqlite backend");
        let account = StoredAccount {
            id: "backend-account".to_owned(),
            name: "Backend".to_owned(),
            handle: "backend".to_owned(),
            password_hash: "hash".to_owned(),
        };
        assert!(storage
            .create_account(&account, 1)
            .await
            .expect("create account"));
        assert_eq!(
            storage
                .sync(&account.id, 0, "")
                .await
                .expect("sync")
                .conversations
                .len(),
            2
        );
    }
}

async fn migrate_postgres(pool: &PgPool) -> Result<(), StorageError> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS schema_migrations (version BIGINT PRIMARY KEY);\
         CREATE TABLE IF NOT EXISTS server_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);\
         CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, name TEXT NOT NULL, handle TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at BIGINT NOT NULL, last_seen_at BIGINT);\
         CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, created_at BIGINT NOT NULL, expires_at BIGINT NOT NULL DEFAULT 0, session_id TEXT, device_id TEXT, platform TEXT NOT NULL DEFAULT 'unknown', device_name TEXT, app_version TEXT, last_seen_at BIGINT);\
         CREATE UNIQUE INDEX IF NOT EXISTS sessions_session_id ON sessions(session_id) WHERE session_id IS NOT NULL;\
         CREATE TABLE IF NOT EXISTS account_settings (account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE, value_json TEXT NOT NULL, updated_at BIGINT NOT NULL);\
         CREATE TABLE IF NOT EXISTS account_folders (account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE, folders_json TEXT NOT NULL, updated_at BIGINT NOT NULL);\
         CREATE TABLE IF NOT EXISTS devices (owner_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, device_id TEXT NOT NULL, platform TEXT NOT NULL DEFAULT 'unknown', name TEXT, app_version TEXT, created_at BIGINT NOT NULL, last_seen_at BIGINT, revoked_at BIGINT, PRIMARY KEY(owner_account_id, device_id));\
         CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, owner_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, name TEXT NOT NULL, handle TEXT, avatar TEXT NOT NULL, subtitle TEXT, can_write BOOLEAN NOT NULL DEFAULT TRUE, last_message TEXT NOT NULL DEFAULT '', last_message_at BIGINT, pinned BOOLEAN NOT NULL DEFAULT FALSE, online BOOLEAN NOT NULL DEFAULT FALSE, sort_order BIGINT NOT NULL DEFAULT 0, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL);\
         CREATE INDEX IF NOT EXISTS conversations_owner_order ON conversations(owner_account_id, pinned DESC, sort_order ASC, created_at ASC);\
         CREATE UNIQUE INDEX IF NOT EXISTS conversations_owner_handle ON conversations(owner_account_id, handle) WHERE handle IS NOT NULL;\
         CREATE TABLE IF NOT EXISTS messages (seq BIGSERIAL PRIMARY KEY, id TEXT NOT NULL UNIQUE, owner_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, author TEXT NOT NULL CHECK(author IN ('me', 'them')), text TEXT NOT NULL DEFAULT '', message_json TEXT NOT NULL DEFAULT '', created_at BIGINT NOT NULL, stack_id TEXT NOT NULL DEFAULT '', client_message_id TEXT NOT NULL, UNIQUE(owner_account_id, client_message_id));\
         CREATE INDEX IF NOT EXISTS messages_owner_cursor ON messages(owner_account_id, seq ASC);\
         CREATE TABLE IF NOT EXISTS media_objects (id TEXT PRIMARY KEY, owner_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, recipient_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, conversation_id TEXT NOT NULL, ciphertext BYTEA NOT NULL, byte_size BIGINT NOT NULL, created_at BIGINT NOT NULL);\
         CREATE INDEX IF NOT EXISTS media_objects_recipient ON media_objects(recipient_account_id, created_at ASC);\
         CREATE TABLE IF NOT EXISTS realtime_event_cursors (account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE, cursor BIGINT NOT NULL);\
         CREATE TABLE IF NOT EXISTS realtime_events (account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, cursor BIGINT NOT NULL, kind TEXT NOT NULL, source_id TEXT NOT NULL, payload_json TEXT NOT NULL, created_at BIGINT NOT NULL, PRIMARY KEY(account_id, cursor), UNIQUE(account_id, kind, source_id));\
         CREATE INDEX IF NOT EXISTS realtime_events_account_cursor ON realtime_events(account_id, cursor ASC);\
         ALTER TABLE accounts ADD COLUMN IF NOT EXISTS last_seen_at BIGINT;\
         CREATE TABLE IF NOT EXISTS conversation_reads (owner_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, read_at BIGINT NOT NULL, PRIMARY KEY(owner_account_id, conversation_id));\
         CREATE TABLE IF NOT EXISTS message_read_receipts (message_id TEXT NOT NULL, reader_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, read_at BIGINT NOT NULL, PRIMARY KEY(message_id, reader_account_id));\
         CREATE TABLE IF NOT EXISTS message_delivery_receipts (message_id TEXT NOT NULL, recipient_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, delivered_at BIGINT NOT NULL, PRIMARY KEY(message_id, recipient_account_id));\
         CREATE TABLE IF NOT EXISTS device_keys (owner_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, device_id TEXT NOT NULL, key_id TEXT NOT NULL, encryption_public_key TEXT NOT NULL, signing_public_key TEXT NOT NULL, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, PRIMARY KEY(owner_account_id, device_id), UNIQUE(owner_account_id, key_id));\
         CREATE TABLE IF NOT EXISTS push_tokens (owner_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, device_id TEXT NOT NULL, token TEXT NOT NULL UNIQUE, platform TEXT NOT NULL CHECK(platform IN ('android', 'ios')), created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, PRIMARY KEY(owner_account_id, device_id));\
         CREATE INDEX IF NOT EXISTS push_tokens_owner ON push_tokens(owner_account_id);\
         CREATE TABLE IF NOT EXISTS account_keys (owner_account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE, key_id TEXT NOT NULL UNIQUE, encryption_public_key TEXT NOT NULL, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL);\
         ALTER TABLE messages ADD COLUMN IF NOT EXISTS message_json TEXT NOT NULL DEFAULT '';\
         ALTER TABLE messages ADD COLUMN IF NOT EXISTS stack_id TEXT NOT NULL DEFAULT '';\
         UPDATE messages SET stack_id = conversation_id || ':' || author || ':' || (created_at / 60000)::TEXT WHERE stack_id = '';\
         UPDATE messages SET text = '' WHERE message_json = '';\
         UPDATE conversations SET last_message = '';\
         INSERT INTO realtime_event_cursors (account_id, cursor) SELECT id, 0 FROM accounts ON CONFLICT (account_id) DO NOTHING;\
         INSERT INTO realtime_events (account_id, cursor, kind, source_id, payload_json, created_at) SELECT owner_account_id, seq, 'message', id, json_build_object('id', id, 'conversation_id', conversation_id, 'author', author, 'created_at', created_at, 'stack_id', stack_id, 'message_json', message_json)::TEXT, created_at FROM messages WHERE message_json <> '' ON CONFLICT DO NOTHING;\
         UPDATE realtime_event_cursors SET cursor = GREATEST(cursor, COALESCE((SELECT MAX(realtime_events.cursor) FROM realtime_events WHERE realtime_events.account_id = realtime_event_cursors.account_id), 0));\
         INSERT INTO realtime_events (account_id, cursor, kind, source_id, payload_json, created_at) SELECT legacy.account_id, cursors.cursor + ROW_NUMBER() OVER (PARTITION BY legacy.account_id ORDER BY legacy.kind, legacy.message_id), legacy.kind, legacy.kind || ':' || legacy.message_id || ':' || legacy.value::TEXT, CASE WHEN legacy.kind = 'readReceipt' THEN json_build_object('message_id', legacy.message_id, 'read_at', legacy.value)::TEXT ELSE json_build_object('message_id', legacy.message_id, 'delivered_at', legacy.value)::TEXT END, legacy.value FROM (SELECT own_messages.owner_account_id AS account_id, receipts.message_id, MAX(receipts.read_at) AS value, 'readReceipt' AS kind FROM message_read_receipts receipts JOIN messages own_messages ON own_messages.id = receipts.message_id WHERE own_messages.author = 'me' GROUP BY own_messages.owner_account_id, receipts.message_id UNION ALL SELECT own_messages.owner_account_id, receipts.message_id, MAX(receipts.delivered_at), 'deliveryReceipt' FROM message_delivery_receipts receipts JOIN messages own_messages ON own_messages.id = receipts.message_id WHERE own_messages.author = 'me' GROUP BY own_messages.owner_account_id, receipts.message_id) legacy JOIN realtime_event_cursors cursors ON cursors.account_id = legacy.account_id ON CONFLICT DO NOTHING;\
         UPDATE realtime_event_cursors SET cursor = GREATEST(cursor, COALESCE((SELECT MAX(realtime_events.cursor) FROM realtime_events WHERE realtime_events.account_id = realtime_event_cursors.account_id), 0));\
         INSERT INTO schema_migrations(version) VALUES (1) ON CONFLICT DO NOTHING",
    )
    .execute(pool)
    .await?;
    let historical_message_column = concat!("env", "elope_json");
    let has_historical_message_column: bool = sqlx::query(
        "SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name = 'messages' AND column_name = $1) AS present",
    )
    .bind(historical_message_column)
    .fetch_one(pool)
    .await?
    .try_get("present")?;
    if has_historical_message_column {
        let has_message_column: bool = sqlx::query(
            "SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name = 'messages' AND column_name = 'message_json') AS present",
        )
        .fetch_one(pool)
        .await?
        .try_get("present")?;
        if has_message_column {
            let copy_statement = format!(
                "UPDATE messages SET message_json = CASE WHEN message_json = '' THEN \"{historical_message_column}\" ELSE message_json END"
            );
            sqlx::query(&copy_statement).execute(pool).await?;
            let drop_statement = format!(
                "ALTER TABLE messages DROP COLUMN \"{historical_message_column}\""
            );
            sqlx::query(&drop_statement).execute(pool).await?;
        } else {
            let rename_statement = format!(
                "ALTER TABLE messages RENAME COLUMN \"{historical_message_column}\" TO message_json"
            );
            sqlx::query(&rename_statement).execute(pool).await?;
        }
        sqlx::query("DELETE FROM realtime_events WHERE kind = 'message'")
            .execute(pool)
            .await?;
        backfill_postgres_message_events(pool).await?;
    }
    sqlx::query(
        "ALTER TABLE sessions ADD COLUMN IF NOT EXISTS expires_at BIGINT NOT NULL DEFAULT 0",
    )
    .execute(pool)
    .await?;
    for statement in [
        "ALTER TABLE sessions ADD COLUMN IF NOT EXISTS session_id TEXT",
        "ALTER TABLE sessions ADD COLUMN IF NOT EXISTS device_id TEXT",
        "ALTER TABLE sessions ADD COLUMN IF NOT EXISTS platform TEXT NOT NULL DEFAULT 'unknown'",
        "ALTER TABLE sessions ADD COLUMN IF NOT EXISTS device_name TEXT",
        "ALTER TABLE sessions ADD COLUMN IF NOT EXISTS app_version TEXT",
        "ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_seen_at BIGINT",
        "CREATE UNIQUE INDEX IF NOT EXISTS sessions_session_id ON sessions(session_id) WHERE session_id IS NOT NULL",
        "CREATE TABLE IF NOT EXISTS account_settings (account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE, value_json TEXT NOT NULL, updated_at BIGINT NOT NULL)",
        "CREATE TABLE IF NOT EXISTS devices (owner_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, device_id TEXT NOT NULL, platform TEXT NOT NULL DEFAULT 'unknown', name TEXT, app_version TEXT, created_at BIGINT NOT NULL, last_seen_at BIGINT, revoked_at BIGINT, PRIMARY KEY(owner_account_id, device_id))",
    ] {
        sqlx::query(statement).execute(pool).await?;
    }
    sqlx::query("UPDATE sessions SET expires_at = created_at + $1 WHERE expires_at <= 0")
        .bind(SESSION_TTL_MS)
        .execute(pool)
        .await?;
    Ok(())
}

async fn postgres_ensure_system_conversations(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    account_id: &str,
    now: i64,
) -> Result<(), StorageError> {
    sqlx::query(
        "INSERT INTO conversations (id, owner_account_id, name, handle, avatar, subtitle, can_write, last_message, pinned, online, sort_order, created_at, updated_at) VALUES ($1, $2, 'Enter', 'official', 'enter-official', 'Официальный чат', FALSE, '', TRUE, TRUE, 0, $3, $3) ON CONFLICT DO NOTHING",
    )
    .bind(format!("enter:{account_id}"))
    .bind(account_id)
    .bind(now)
    .execute(&mut **transaction)
    .await?;
    sqlx::query(
        "INSERT INTO conversations (id, owner_account_id, name, handle, avatar, subtitle, can_write, last_message, pinned, online, sort_order, created_at, updated_at) VALUES ($1, $2, 'Избранное', 'favorites', 'favorites', 'Личные сохранения', TRUE, '', TRUE, FALSE, 1, $3, $3) ON CONFLICT DO NOTHING",
    )
    .bind(format!("favorites:{account_id}"))
    .bind(account_id)
    .bind(now)
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

async fn backfill_postgres_message_events(pool: &PgPool) -> Result<(), StorageError> {
    sqlx::query(
        "WITH candidates AS (
             SELECT messages.owner_account_id, messages.id, messages.conversation_id, messages.author,
                    messages.created_at, messages.stack_id, messages.message_json,
                    realtime_event_cursors.cursor + ROW_NUMBER() OVER (
                        PARTITION BY messages.owner_account_id ORDER BY messages.seq
                    ) AS next_cursor
             FROM messages
             JOIN realtime_event_cursors
               ON realtime_event_cursors.account_id = messages.owner_account_id
             WHERE messages.message_json <> ''
         )
         INSERT INTO realtime_events (account_id, cursor, kind, source_id, payload_json, created_at)
         SELECT owner_account_id, next_cursor, 'message', id,
                json_build_object(
                    'id', id,
                    'conversation_id', conversation_id,
                    'author', author,
                    'created_at', created_at,
                    'stack_id', stack_id,
                    'message_json', message_json
                )::TEXT,
                created_at
         FROM candidates
         ON CONFLICT DO NOTHING",
    )
    .execute(pool)
    .await?;
    sqlx::query(
        "UPDATE realtime_event_cursors
         SET cursor = GREATEST(
             cursor,
             COALESCE((
                 SELECT MAX(realtime_events.cursor)
                 FROM realtime_events
                 WHERE realtime_events.account_id = realtime_event_cursors.account_id
             ), 0)
         )",
    )
    .execute(pool)
    .await?;
    Ok(())
}

async fn postgres_ensure_all_system_conversations(
    pool: &PgPool,
    now: i64,
) -> Result<(), StorageError> {
    let account_ids = sqlx::query("SELECT id FROM accounts")
        .fetch_all(pool)
        .await?
        .into_iter()
        .map(|row| row.try_get::<String, _>("id"))
        .collect::<Result<Vec<_>, sqlx::Error>>()?;
    let mut transaction = pool.begin().await?;
    for account_id in account_ids {
        postgres_ensure_system_conversations(&mut transaction, &account_id, now).await?;
    }
    transaction.commit().await?;
    Ok(())
}
