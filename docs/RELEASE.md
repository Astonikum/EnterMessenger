# Production releases

Релизы запускаются вручную из GitHub Actions:

- `Desktop release` — Windows x64, Linux x64, macOS Intel и macOS Apple Silicon.
- `Mobile release` — Android через EAS; по умолчанию профиль `preview` создает устанавливаемый `.apk` и прикрепляет его к draft-релизу. Профиль `production` создает `.aab` для Google Play; параметр `submit` отдельно включает отправку в Google Play.
- `CI` запускается на pull request и push в `main` и проверяет desktop/mobile, VS Code extension и server.

## Версии

Перед запуском действия версия должна быть изменена в соответствующих manifest-файлах и закоммичена:

- desktop: `desktop/package.json`, `desktop/src-tauri/Cargo.toml`, `desktop/src-tauri/tauri.conf.json`;
- mobile: `mobile/package.json`, `mobile/app.json`.

Desktop action создает draft-релиз с тегом `desktop-v<version>`, а Mobile action — draft-релиз с тегом `mobile-v<version>`. Версия указывается в названии и теге релиза и берется отдельно из manifest соответствующей платформы. Артефакты прикрепляются к draft-релизу; после проверки его можно опубликовать вручную.

Для мобильного тестового релиза выбери `platform: android`, `profile: preview` и `submit: false`. APK появится во вкладке Assets draft-релиза. Для Google Play выбери `profile: production` и включи `submit` — этот вариант выпускает AAB.

## Хранение данных

Desktop использует стабильный Tauri identifier `com.enter.messenger`. `localStorage`, IndexedDB, кэш сообщений, outbox и локальные E2E-ключи живут в каталоге данных WebView приложения и не зависят от папки установки:

- Windows: `%LOCALAPPDATA%\com.enter.messenger`;
- Linux: `~/.local/share/com.enter.messenger`;
- macOS: `~/Library/Application Support/com.enter.messenger`.

Обновления не должны менять identifier и не должны очищать WebView data directory — иначе пользователь потеряет локальную сессию, кэш и ключи.

Mobile хранит обычное состояние и кэш через AsyncStorage, а приватные device/account keys — через SecureStore (с fallback в AsyncStorage на платформах, где SecureStore недоступен). Удаление приложения может удалить эти данные согласно политике ОС.

## Одноразовая настройка EAS

В Expo нужно один раз создать/связать EAS project и настроить store credentials:

```bash
cd mobile
npx eas-cli login
npx eas-cli build:configure
```

После этого добавь в GitHub Actions secrets:

- `EXPO_TOKEN` — токен Expo;
- `EXPO_OWNER` — Expo account/organization, если owner не задан в конфиге.

Project ID `aaa033ad-a37f-4ad4-b608-394d0a21320e` зафиксирован в
`mobile/app.config.js`; отдельный secret для него не нужен.

Для `submit: true` должны быть настроены Android keystore и Google Play service account. Без этих секретов action может собрать артефакт, но не сможет отправить его в Google Play.

## Подпись desktop

Текущий action готовит release-артефакты, но signing secrets еще не заведены. Перед публичным распространением нужно добавить code-signing для Windows и Apple Developer signing/notarization для macOS. Linux-пакеты можно выпускать без отдельного store signing.

## Security follow-up

`npm ci` для desktop проходит без advisories. Mobile собирается и проходит typecheck,
но текущий Expo SDK 52 дает 23 транзитивных npm advisories (включая 1 critical)
в инструментах Expo/Metro. Автоматический `npm audit fix --force` требует breaking
upgrade Expo/React Native, поэтому он намеренно не применен вслепую. Перед публичным
релизом нужно отдельно обновить Expo SDK, прогнать native smoke tests и закрыть этот
audit debt.
