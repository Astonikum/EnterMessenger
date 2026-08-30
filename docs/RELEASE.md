# Production releases

Релизы запускаются вручную из GitHub Actions:

- `Desktop release` — Windows x64, Linux x64, macOS Intel и macOS Apple Silicon.
- На macOS action дополнительно выпускает `Enter-Messenger_<version>_<arch>.pkg`.
- `Mobile release` — нативная сборка Android через Gradle и iOS через Xcode/CocoaPods.
- `CI` запускается на pull request и push в `main` и проверяет desktop/mobile, VS Code
  extension и server.

## Версии

Перед запуском действия версия должна быть изменена в соответствующих manifest-файлах
и закоммичена:

- desktop: `desktop/package.json`, `desktop/src-tauri/Cargo.toml`,
  `desktop/src-tauri/tauri.conf.json`;
- mobile: `mobile/package.json`, `mobile/app.json`, Android Gradle config и Xcode project.

Desktop action создаёт draft-релиз с тегом `desktop-v<version>`, а Mobile action —
draft-релиз с тегом `mobile-v<version>`. Версия указывается в названии и теге релиза.
Артефакты прикрепляются к draft-релизу; после проверки его можно опубликовать вручную.

## Mobile release

В workflow выберите:

- `android` и `apk` для устанавливаемого тестового APK;
- `android` и `aab` для Google Play bundle;
- `ios` для compile-only simulator `.app.zip`;
- `both` для Android и iOS одновременно.

Сборка выполняется на runner-е GitHub и не использует Expo/EAS. Для Android AAB
добавьте secrets `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`,
`ANDROID_KEY_ALIAS` и `ANDROID_KEY_PASSWORD`; workflow подключает keystore к Gradle.
Для iOS App Store
публикации добавьте Apple Developer certificate, provisioning profile и App Store
Connect credentials; текущая iOS job проверяет нативную сборку без signing.

## Хранение данных

Desktop использует стабильный Tauri identifier `com.enter.messenger`. `localStorage`,
IndexedDB, кэш сообщений, outbox и локальные E2E-ключи живут в каталоге данных WebView
приложения и не зависят от папки установки:

- Windows: `%LOCALAPPDATA%\com.enter.messenger`;
- Linux: `~/.local/share/com.enter.messenger`;
- macOS: `~/Library/Application Support/com.enter.messenger`.

Обновления не должны менять identifier и не должны очищать WebView data directory —
иначе пользователь потеряет локальную сессию, кэш и ключи.

Mobile хранит обычное состояние и кэш через AsyncStorage, а приватные device/account keys
через системный Keychain/Keystore. Удаление приложения может удалить эти данные согласно
политике ОС.

## Подпись desktop

Текущий action готовит release-артефакты, но signing secrets еще не заведены. Перед
публичным распространением нужно добавить code-signing для Windows и Apple Developer
signing/notarization для macOS. Linux-пакеты можно выпускать без отдельного store signing.

## Установка desktop на macOS

Для установки в `/Applications` используйте `.pkg` из draft-релиза. Installer размещает
полный `.app` в системной папке Applications и postinstall-регистрацией добавляет его в
LaunchServices; запуск приложения вручную для регистрации не требуется.

DMG остаётся доступным как стандартный drag-and-drop сценарий: перетащите `Enter Messenger.app`
в `/Applications` и извлеките образ. Не запускайте приложение прямо со смонтированного DMG,
из `Downloads` или из временной папки — в этих местах LaunchServices может оставить старую
или дублирующую запись.

Текущие macOS `.pkg`/DMG не подписываются и не notarize-ятся: для публичной раздачи всё ещё
нужны Apple Developer signing/notarization secrets, иначе Gatekeeper может показать системное
предупреждение даже у корректно установленного приложения.

## Security follow-up

`npm ci` для mobile сейчас сообщает advisories в транзитивных пакетах. Автоматический
`npm audit fix --force` намеренно не применялся: он может поднять React Native или
нативные зависимости через breaking upgrade. Перед публичным релизом нужно отдельно
просмотреть audit report и выполнить native smoke tests на реальных Android/iOS устройствах.
