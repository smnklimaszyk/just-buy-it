import { describe, expect, it } from "vitest";
import { createLru } from "./lru.js";

describe("createLru", () => {
  it("returns stored values and undefined for missing keys", () => {
    const lru = createLru<string, number>(3);
    lru.set("a", 1);

    expect(lru.get("a")).toBe(1);
    expect(lru.get("b")).toBeUndefined();
  });

  it("counts a read as a use, so the least recently used key is evicted past capacity", () => {
    const lru = createLru<string, number>(2);
    lru.set("a", 1);
    lru.set("b", 2);
    lru.get("a");
    lru.set("c", 3);

    expect(lru.get("a")).toBe(1);
    expect(lru.get("b")).toBeUndefined();
    expect(lru.get("c")).toBe(3);
    expect(lru.size).toBe(2);
  });

  it("counts an overwrite as a use, does not grow, and deletes a key", () => {
    const lru = createLru<string, number>(2);
    lru.set("a", 1);
    lru.set("b", 2);
    lru.set("a", 10);
    lru.set("c", 3);

    expect(lru.get("a")).toBe(10);
    expect(lru.get("b")).toBeUndefined();
    expect(lru.size).toBe(2);

    lru.delete("a");
    expect(lru.get("a")).toBeUndefined();
    expect(lru.size).toBe(1);
  });

  it("drops the least recently used of 10,000 keys at the 10,001st", () => {
    const lru = createLru<string, number>(10_000);
    for (let i = 0; i < 10_000; i++) lru.set(`kid-${i}`, i);
    lru.get("kid-0");
    lru.set("kid-10000", 10_000);

    expect(lru.size).toBe(10_000);
    expect(lru.get("kid-0")).toBe(0);
    expect(lru.get("kid-1")).toBeUndefined();
    expect(lru.get("kid-10000")).toBe(10_000);
  });
});
