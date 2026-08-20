# Enter — React Native

Мобильная версия вынесена отдельно от desktop/Tauri-клиента в эту папку.

```bash
cd mobile
npm install
npm start
```

Для Android/iOS используйте Expo Go или development build. При подключении к локальному серверу с телефона указывайте IP компьютера в сети, например `192.168.1.12:50121`, а не `localhost:50121`.

Проверки проекта:

```bash
npm run typecheck
npm run test:crypto
npx expo export --platform android
npx expo export --platform ios
```

Ручной production-релиз запускается действием `Mobile release` в GitHub Actions.
Сборка требует secret `EXPO_TOKEN`; project ID уже указан в конфигурации. Отправка в магазины
дополнительно требует настроенных EAS credentials. Полная инструкция находится
в [docs/RELEASE.md](../docs/RELEASE.md).

В мобильном интерфейсе сохранены авторизация через Enter API, профили серверов, поиск пользователей, список чатов, чат, ответы/редактирование/реакции/закрепление/сохранение/пересылка сообщений и настройки. Приватные device keys хранятся в SecureStore, кэш — в AsyncStorage. Сообщения проходят тот же E2E-контракт Enter: P-256, HKDF-SHA-256 и AES-256-GCM; синхронизация выполняется в фоне.

Выбор вложений и аудио/видеозвонки оставлены за пределами мобильного клиента до появления соответствующих endpoint-ов в Enter API.
