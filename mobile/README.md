# Enter — React Native

Мобильный клиент — обычное React Native CLI-приложение с исходными Android/iOS-проектами.
Expo Go, EAS и платные hosted builds не используются.

```bash
cd mobile
npm install
npm start
```

Для Android нужен JDK 17 и Android SDK. Запуск на подключённом устройстве или эмуляторе:

```bash
npm run android
```

Локальный Android build можно использовать только как smoke-check миграции:

```bash
npm run build:android
# локальный диагностический артефакт, не release-публикация
```

Для iOS нужен Xcode и CocoaPods:

```bash
cd ios
pod install
cd ..
npm run ios
```

При подключении к локальному серверу с телефона указывайте IP компьютера в сети,
например `192.168.1.12:50121`, а не `localhost:50121`.

Проверки проекта:

```bash
npm run typecheck
npm run test:crypto
npm run test:state
npm run test:realtime
npx react-native config
```

Единственный release-процесс запускается действием `Mobile release` в GitHub Actions. Android job
использует JDK, Gradle и Android SDK GitHub runner-а; iOS job использует Xcode и
CocoaPods runner-а. Для публикации в Google Play понадобится signing keystore, а для
App Store — сертификат и provisioning profile. Эти credentials не являются частью
репозитория.

Локальные уведомления работают через Notifee. Удалённая доставка в фоне через FCM/APNs
потребует отдельно добавить серверную доставку и production credentials; прежний
hosted push provider для этого не используется.

В интерфейсе сохранены авторизация через Enter API, профили серверов, поиск пользователей,
список чатов, чат, ответы/редактирование/реакции/закрепление/сохранение/пересылка сообщений
и настройки. Приватные device keys хранятся в Keychain/Keystore, кэш — в AsyncStorage.
Сообщения проходят тот же E2E-контракт Enter: P-256, HKDF-SHA-256 и AES-256-GCM;
синхронизация выполняется в фоне.
