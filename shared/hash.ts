/** FNV-1a 32-bit. Stable across platforms for the same string. */
export function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Unit interval from a string. Same input always returns the same value. */
export function hashUnit(text: string): number {
  return fnv1a(text) / 4294967296;
}
