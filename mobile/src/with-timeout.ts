export const NATIVE_OPERATION_TIMEOUT_MS = 10_000;

export function withTimeout<T>(operation: Promise<T>, message: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), NATIVE_OPERATION_TIMEOUT_MS);
  });
  return Promise.race([operation, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
