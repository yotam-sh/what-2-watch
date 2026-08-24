import { describe, expect, it } from "vitest";
import { coerceArray, coerceBool, coerceInt, coerceNumber, coerceString } from "./util";

describe("coerceNumber", () => {
  it("passes through a real number", () => {
    expect(coerceNumber(42)).toBe(42);
  });

  it("coerces a numeric string (constraint 8)", () => {
    expect(coerceNumber("42")).toBe(42);
  });

  it("returns undefined for garbage", () => {
    expect(coerceNumber("not a number")).toBeUndefined();
    expect(coerceNumber(undefined)).toBeUndefined();
    expect(coerceNumber(null)).toBeUndefined();
    expect(coerceNumber("")).toBeUndefined();
  });

  it("returns undefined for NaN/Infinity", () => {
    expect(coerceNumber(NaN)).toBeUndefined();
    expect(coerceNumber(Infinity)).toBeUndefined();
  });
});

describe("coerceInt", () => {
  it("truncates a float-looking string", () => {
    expect(coerceInt("42.9")).toBe(42);
  });
});

describe("coerceArray", () => {
  it("wraps a bare single object into a one-element array", () => {
    const single = { id: "tmdb://603" };
    expect(coerceArray(single)).toEqual([single]);
  });

  it("passes through a real array unchanged", () => {
    const arr = [{ id: "a" }, { id: "b" }];
    expect(coerceArray(arr)).toBe(arr);
  });

  it("returns [] for an omitted (undefined) collection — constraint 8", () => {
    expect(coerceArray(undefined)).toEqual([]);
  });

  it("returns [] for null", () => {
    expect(coerceArray(null)).toEqual([]);
  });
});

describe("coerceString", () => {
  it("passes through a string", () => {
    expect(coerceString("hello")).toBe("hello");
  });
  it("stringifies a number", () => {
    expect(coerceString(603)).toBe("603");
  });
  it("returns undefined for anything else", () => {
    expect(coerceString(undefined)).toBeUndefined();
    expect(coerceString(null)).toBeUndefined();
    expect(coerceString({})).toBeUndefined();
  });
});

describe("coerceBool", () => {
  it("handles Plex's various boolean-ish encodings", () => {
    expect(coerceBool(true)).toBe(true);
    expect(coerceBool(false)).toBe(false);
    expect(coerceBool(1)).toBe(true);
    expect(coerceBool(0)).toBe(false);
    expect(coerceBool("1")).toBe(true);
    expect(coerceBool("0")).toBe(false);
    expect(coerceBool("true")).toBe(true);
    expect(coerceBool(undefined)).toBe(false);
  });
});
