const SERVER_ERROR_MESSAGES: Record<string, string> = {
  cannot_revoke_current_device: "Нельзя удалить устройство, на котором вы сейчас вошли.",
  cannot_revoke_current_session: "Нельзя завершить текущую сессию.",
  handle_taken: "Пользователь с таким никнеймом уже существует. Выберите другой.",
  handle_token: "Пользователь с таким никнеймом уже существует. Выберите другой.",
  invalid_credentials: "Неверный логин или пароль.",
  invalid_registration: "Проверьте имя, логин и пароль.",
  invalid_handle: "Некорректный формат никнейма.",
  invalid_name: "Введите корректное имя.",
  invalid_password: "Пароль не соответствует требованиям.",
  invalid_conversation: "Некорректный идентификатор чата.",
  invalid_command: "Не удалось обработать запрос.",
  unauthorized: "Сессия истекла. Войдите снова.",
  invalid_session: "Сессия недействительна. Войдите снова.",
  session_not_found: "Сессия не найдена. Войдите снова.",
  device_key_not_registered: "На этом устройстве не настроено шифрование. Повторите вход.",
  device_not_found: "Устройство не найдено или уже удалено.",
  invalid_device: "Данные устройства недействительны. Повторите настройку.",
  invalid_device_key: "Ключ устройства недействителен. Повторите настройку.",
  invalid_account_key: "Ключ аккаунта недействителен. Повторите настройку.",
  recipient_not_found: "Пользователь не найден.",
  user_not_found: "Пользователь не найден.",
  recipient_key_not_registered: "У пользователя ещё не настроено шифрование.",
  conversation_not_found: "Чат не найден.",
  conversation_read_only: "Этот чат доступен только для чтения.",
  message_not_found: "Сообщение не найдено.",
  invalid_message: "Не удалось обработать сообщение.",
  invalid_encrypted_message: "Не удалось обработать зашифрованное сообщение.",
  invalid_stored_encrypted_message: "Не удалось синхронизировать зашифрованное сообщение.",
  invalid_history_entry: "Не удалось синхронизировать историю сообщений.",
  too_many_history_entries: "История сообщений слишком большая для синхронизации.",
  media_not_found: "Вложение не найдено.",
  media_too_large: "Вложение слишком большое.",
  media_too_small: "Вложение пустое или повреждено.",
  media_recipient_not_found: "Не удалось найти получателя вложения.",
  media_recipient_remote: "Вложения для удалённых пользователей пока недоступны.",
  invalid_media_metadata: "Не удалось обработать данные вложения.",
  invalid_media_recipient: "Некорректный получатель вложения.",
  media_response_failed: "Сервер не подтвердил загрузку вложения.",
  storage_failed: "Сервер временно не может сохранить данные. Попробуйте позже.",
  password_hash_failed: "Сервер не смог обработать пароль. Попробуйте позже.",
  too_many_connections: "Слишком много подключений. Попробуйте позже.",
  frame_too_large: "Запрос слишком большой.",
  federation_delivery_failed: "Не удалось доставить сообщение на удалённый сервер.",
  federation_not_configured: "Удалённый сервер не настроен для доставки сообщений.",
  federation_unauthorized: "Удалённый сервер отклонил доставку сообщения.",
  federation_loop: "Сообщение нельзя доставить: обнаружен повторный маршрут.",
  invalid_federation_delivery: "Удалённый сервер вернул некорректный ответ.",
  wrong_recipient_server: "Получатель находится на другом сервере.",
  invalid_push_token: "Не удалось зарегистрировать уведомления на этом устройстве.",
  unsupported_protocol: "Сервер использует неподдерживаемую версию Enter API.",
  unsupported_command: "Сервер не поддерживает эту операцию.",
  unsupported_frame: "Сервер получил неподдерживаемый формат данных.",
  origin_not_allowed: "Это приложение не разрешено для данного сервера.",
};

const LOCAL_ERROR_MESSAGES: Record<string, string> = {
  OUTBOX_FULL: "Очередь отправки переполнена. Дождитесь отправки предыдущих сообщений.",
  "Enter API вернул некорректный ответ": "Сервер вернул некорректный ответ. Попробуйте позже.",
  "Ключ устройства отправителя не найден": "Не удалось найти ключ шифрования отправителя.",
};

export function friendlyError(reason: unknown, fallback: string) {
  const raw = reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "";
  for (const [code, message] of Object.entries(SERVER_ERROR_MESSAGES)) {
    if (raw.includes(code)) return message;
  }
  for (const [technicalMessage, message] of Object.entries(LOCAL_ERROR_MESSAGES)) {
    if (raw.includes(technicalMessage)) return message;
  }
  return fallback;
}
