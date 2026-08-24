// ---------------------------------------------------------------------------
// Tiny typed fetch wrapper shared by every client component that talks to
// this app's own API routes. Not unit-tested (it's a thin network shim, not
// logic) — see src/lib/ui/* for the pure/testable pieces that consume its
// output.
// ---------------------------------------------------------------------------
"use client";

export interface ApiResult<T> {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
}

async function request<T>(url: string, init?: RequestInit): Promise<ApiResult<T>> {
  try {
    const res = await fetch(url, init);
    const data = (await res.json().catch(() => undefined)) as (T & { error?: string }) | undefined;
    if (!res.ok) {
      return { ok: false, status: res.status, data, error: data?.error ?? `Request failed (${res.status}).` };
    }
    return { ok: true, status: res.status, data };
  } catch {
    return { ok: false, status: 0, error: "Network error — please check your connection." };
  }
}

export function getJson<T>(url: string): Promise<ApiResult<T>> {
  return request<T>(url);
}

export function postJson<T>(url: string, body?: unknown): Promise<ApiResult<T>> {
  return request<T>(url, {
    method: "POST",
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}
