const headers = { "X-Tenant-Id": "acme", "X-Actor-Id": "demo.admin" };
export async function get<T>(path: string): Promise<T> { const r = await fetch(`/api/v1${path}`, { headers }); if (!r.ok) throw new Error((await r.json()).error); return r.json(); }
export async function post<T>(path: string, data: unknown): Promise<T> { const r = await fetch(`/api/v1${path}`, { method: "POST", headers: { ...headers, "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify(data) }); if (!r.ok) throw new Error((await r.json()).error); return r.json(); }
