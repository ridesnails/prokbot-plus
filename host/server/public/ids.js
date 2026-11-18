// crypto.randomUUID() is secure-context only. The Host admin page also runs on LAN HTTP.
let sequence = 0;

export function clientId(prefix = 'item', cryptoImpl = globalThis.crypto) {
  try {
    const value = cryptoImpl?.randomUUID?.();
    if (typeof value === 'string' && value) return `${prefix}-${value.slice(0, 8)}`;
  } catch {}
  try {
    const values = new Uint32Array(2);
    cryptoImpl?.getRandomValues?.(values);
    if (values[0] || values[1]) return `${prefix}-${values[0].toString(36)}${values[1].toString(36)}`;
  } catch {}
  sequence += 1;
  return `${prefix}-${Date.now().toString(36)}${sequence.toString(36)}`;
}
