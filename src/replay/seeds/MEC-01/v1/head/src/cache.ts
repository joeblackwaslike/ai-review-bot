interface Entry<T> {
  value: T;
  expiresAt: number;
}

export class TtlCache<T> {
  private entries = new Map<string, Entry<T>>();

  constructor(private ttlMs: number) {}

  get(key: string): T | undefined {
    const hit = this.entries.get(key);
    if (!hit || hit.expiresAt < Date.now()) return undefined;
    return hit.value;
  }

  set(key: string, value: T) {
    this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }
}
