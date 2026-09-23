/** tokenStore: the small storage abstraction shared by every client-side token (#102). */
import { afterEach, describe, expect, it } from "vitest";
import { tokenStore } from "./tokenStore";

afterEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});

describe("tokenStore", () => {
  it("get() returns null before anything is set", () => {
    const store = tokenStore("session", "tokenstore-test-key");
    expect(store.get()).toBeNull();
  });

  it("session kind reads/writes sessionStorage, not localStorage", () => {
    const store = tokenStore("session", "tokenstore-test-key");
    store.set("s1");
    expect(store.get()).toBe("s1");
    expect(sessionStorage.getItem("tokenstore-test-key")).toBe("s1");
    expect(localStorage.getItem("tokenstore-test-key")).toBeNull();
  });

  it("local kind reads/writes localStorage, not sessionStorage", () => {
    const store = tokenStore("local", "tokenstore-test-key");
    store.set("l1");
    expect(store.get()).toBe("l1");
    expect(localStorage.getItem("tokenstore-test-key")).toBe("l1");
    expect(sessionStorage.getItem("tokenstore-test-key")).toBeNull();
  });

  it("clear() removes the value", () => {
    const store = tokenStore("session", "tokenstore-test-key");
    store.set("s1");
    store.clear();
    expect(store.get()).toBeNull();
  });

  it("two stores with different keys under the same kind don't collide", () => {
    const a = tokenStore("session", "tokenstore-key-a");
    const b = tokenStore("session", "tokenstore-key-b");
    a.set("va");
    b.set("vb");
    expect(a.get()).toBe("va");
    expect(b.get()).toBe("vb");
    a.clear();
    expect(a.get()).toBeNull();
    expect(b.get()).toBe("vb"); // unaffected
  });

  it("two stores with the same key but different kinds don't collide", () => {
    const sessionStore = tokenStore("session", "tokenstore-shared-key");
    const localStore = tokenStore("local", "tokenstore-shared-key");
    sessionStore.set("session-value");
    localStore.set("local-value");
    expect(sessionStore.get()).toBe("session-value");
    expect(localStore.get()).toBe("local-value");
  });
});
