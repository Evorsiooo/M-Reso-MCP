export const DEFAULT_BASE = "https://data.mobilites-m.fr/api";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Thin client for the Mobilités M open data API. Holds no data of its own. */
export class MApi {
  constructor(
    private base: string = DEFAULT_BASE,
    private fetchFn: typeof fetch = (...a) => fetch(...a),
  ) {}

  async get<T = any>(path: string, params: Record<string, string | number | boolean | undefined> = {}): Promise<T> {
    const url = new URL(this.base.replace(/\/$/, "") + path);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    const res = await this.fetchFn(url.toString(), {
      // The Mobilités M API asks clients to identify themselves via the origin header.
      headers: { accept: "application/json", origin: "m-reso-mcp" },
    });
    if (res.status === 204) return null as T; // the API answers 204 with an empty body for "no results"
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 200);
      throw new ApiError(res.status, `Mobilités M API ${res.status} for ${url.pathname}${detail ? `: ${detail}` : ""}`);
    }
    return (await res.json()) as T;
  }

  /** URL (not fetched) of an API resource, for links returned to the user. */
  url(path: string, params: Record<string, string> = {}): string {
    const u = new URL(this.base.replace(/\/$/, "") + path);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return u.toString();
  }
}
