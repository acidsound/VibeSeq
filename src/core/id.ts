let fallbackCounter = 0;

export function createId(prefix = 'id'): string {
  const cryptoObject = (globalThis as { crypto?: Crypto }).crypto;
  if (cryptoObject?.randomUUID) return `${prefix}-${cryptoObject.randomUUID()}`;
  fallbackCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${fallbackCounter.toString(36)}`;
}
