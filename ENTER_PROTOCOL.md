# Enter Protocol

Enter — это federated messaging protocol для мессенджера: у пользователя есть переносимый адрес `handle@server`, а сервер пользователя отвечает за маршрутизацию и доставку сообщений между серверами.

## Границы доверия

- Клиент владеет identity key, device keys и состоянием сессии.
- Домашний сервер хранит аккаунт, публичные device key bundles и зашифрованные сообщения для доставки в диалоги.
- Серверы маршрутизируют зашифрованные сообщения, но не получают plaintext и не имеют ключей расшифровки.
- Межсерверная доставка идёт на сервер получателя через `/.well-known/enter` и `POST /enter/v1/federation/deliveries`.

## Адреса и discovery

Канонический адрес: `handle@server`. Server может быть доменом, IP или `localhost:50121` в development.

`GET /.well-known/enter` возвращает версию протокола, capabilities, federation endpoints и cryptographic profile. Клиент не должен угадывать возможности сервера после discovery.

## Сообщение и шифрование

На уровне транспорта каждое сообщение представлено структурой `EncryptedEnvelope`: message id, conversation id, sender/recipient addresses, device/key ids, nonce, эфемерный public key, associated data, ciphertext и signature. Поля `ciphertext`, `nonce` и `signature` — opaque для relay.

`/api/v1/messages` принимает набор зашифрованных представлений одного сообщения (поле `envelope` остаётся совместимым со старым форматом). Клиент создаёт отдельную копию сообщения для каждого зарегистрированного устройства отправителя и получателя. Сервер сохраняет ciphertext и метаданные без plaintext; `/api/v1/sync` отдаёт копии клиенту, где выполняются проверка подписи, выбор копии для текущего устройства и расшифровка. Повторная отправка с тем же client message id идемпотентна.

## Криптографический слой

- ECDSA P-256/SHA-256 — подпись device key и зашифрованной копии сообщения.
- ECDH P-256 — согласование ключа устройства с эфемерным ключом сообщения.
- AES-256-GCM — шифрование plaintext и authenticated associated data.
- Groups пока отключены: MLS подключается отдельным профилем, когда появится групповая модель.

Криптография должна использовать проверенную библиотеку. В клиенте используются Web Crypto API и системное IndexedDB; primitives не реализуются вручную внутри UI.

## Первый контракт

- `enter/0.1` — текущая версия discovery и message contract.
- `/.well-known/enter` — server discovery и cryptographic profile.
- `POST /enter/v1/keys` — публикация публичного device key bundle после авторизации.
- `GET /enter/v1/keys/{handle}` — публичный каталог ключей получателя.
- `/enter/v1/federation/deliveries` — opaque federation message delivery foundation.

Приватные device keys создаются через Web Crypto и сохраняются в IndexedDB приложения; они не отправляются на сервер. Для каждого сообщения создаётся новый эфемерный ECDH-ключ, а подпись покрывает зашифрованную копию сообщения.

Прямой E2E v1 завершён для текущих диалогов. Federation delivery остаётся транспортным слоем: маршрутизация между разными серверами, server-to-server authentication и группы требуют отдельных протокольных профилей.
