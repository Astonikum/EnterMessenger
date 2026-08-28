# Enter Messenger

Архитектура федерации и криптографические границы описаны в [ENTER_PROTOCOL.md](ENTER_PROTOCOL.md).

Tauri + React desktop-приложение находится в [desktop](desktop).

```bash
cd desktop
npm install
npm run dev
npm run tauri dev
```

Мобильная React Native-версия находится отдельно в [mobile](mobile/README.md).

Инструкция по production-проверкам и ручным desktop/mobile-релизам находится в
[docs/RELEASE.md](docs/RELEASE.md).

## Настройка Enter-сервера

Сервер настраивается переменными окружения. Пример находится в
[server/.env.example](server/.env.example). `ENTER_SERVER_NAME` и логотип
публикуются через `/health` и `/.well-known/enter`, поэтому клиент показывает
брендинг выбранного сервера сам.

Для хранения данных используется `ENTER_DATABASE_URL`:

- `sqlite://server/data/enter.sqlite3` — вариант по умолчанию;
- `postgres://user:password@host:5432/database` — PostgreSQL.

Таблицы создаются автоматически при запуске. Для добавления нового движка
нужно реализовать следующий backend в `server/src/storage.rs`, не меняя API
синхронизации и сообщений.

Сервер запускается из корня командой:

```bash
cargo run --manifest-path server/Cargo.toml
```

### Docker

Для запуска контейнера с SQLite:

Если локальный `cargo run` уже занимает порт `50121`, остановите его перед запуском контейнера.
Этот compose-файл рассчитан на локальный запуск и по умолчанию публикует `http://127.0.0.1:50121`; для удалённых клиентов задайте `ENTER_SERVER_URL` адресом, доступным из сети клиентов. Для deploy-конфигурации используйте [deploy/enter/.env.example](deploy/enter/.env.example).

```bash
docker compose up --build -d
docker compose ps
curl http://127.0.0.1:50121/health
```

Данные хранятся в volume `enter-server-data`. Для остановки контейнера:

```bash
docker compose down
```

## E2E

Клиентский E2E v1 включён для сообщений и «Избранного»: device keys создаются
через Web Crypto, а приватные ключи хранятся локально — в IndexedDB desktop-клиента
и SecureStore mobile-клиента. Сервер получает
только подписанные AES-256-GCM сообщения в зашифрованном transport-формате, без поля plaintext `text`. Публичные
ключи публикуются через `/enter/v1/keys`, а клиент проверяет подпись и расшифровывает
сообщения после синхронизации.

## React Component Preview

VS Code extension полностью изолирован в [vscode-extension](vscode-extension). В нём находятся manifest, runtime-код, тесты, документация и собственная упаковка VSIX.

```bash
cd vscode-extension
npm ci
npm test
npm run package
```

Для разработки расширения откройте корень проекта в VS Code и нажмите `F5`. Полная инструкция находится в [vscode-extension/README.md](vscode-extension/README.md), документация синтаксиса — в [vscode-extension/docs/preview.md](vscode-extension/docs/preview.md).
