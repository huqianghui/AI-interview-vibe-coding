/**
 * Small storage abstraction shared by every token the frontend keeps client-side (admin JWT,
 * candidate JWT, anonymous session token). Each call site picks a storage kind (sessionStorage —
 * cleared when the tab closes, used for auth tokens — or localStorage — survives reloads, used for
 * the anon session token so an interview can resume after a refresh) and a storage key, and gets
 * back a tiny {get,set,clear} object. Guards every access behind a `typeof ... !== "undefined"`
 * check so this is safe to import in non-browser test/SSR contexts.
 */

export type TokenStoreKind = "session" | "local";

function storageFor(kind: TokenStoreKind): Storage | null {
  if (kind === "session") {
    return typeof sessionStorage !== "undefined" ? sessionStorage : null;
  }
  return typeof localStorage !== "undefined" ? localStorage : null;
}

export interface TokenStore {
  get(): string | null;
  set(value: string): void;
  clear(): void;
}

export function tokenStore(kind: TokenStoreKind, key: string): TokenStore {
  return {
    get(): string | null {
      return storageFor(kind)?.getItem(key) ?? null;
    },
    set(value: string): void {
      storageFor(kind)?.setItem(key, value);
    },
    clear(): void {
      storageFor(kind)?.removeItem(key);
    },
  };
}
