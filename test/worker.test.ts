import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { MApi } from "../src/api";
import { handleMcp } from "../src/mcp";
import { toLocalDateTime } from "../src/time";

const mockApi = (routes: Record<string, any>) =>
  new MApi("https://x/api", (async (u: string) => {
    const url = new URL(u);
    const hit = routes[decodeURIComponent(url.pathname).replace("/api", "")];
    if (!hit) return new Response("nope", { status: 404 });
    return Response.json(typeof hit === "function" ? hit(url) : hit);
  }) as any);

const call = (api: MApi, name: string, args: any) =>
  handleMcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, api) as any;

describe("time", () => {
  it("normalises inputs", () => {
    expect(toLocalDateTime("2026-11-03T18:30")).toEqual({ date: "2026-11-03", time: "18:30" });
    expect(toLocalDateTime("2026-11-03T17:30:00Z")).toEqual({ date: "2026-11-03", time: "18:30" });
  });
});

describe("mcp", () => {
  it("lists 8 tools", async () => {
    const r: any = await handleMcp({ jsonrpc: "2.0", id: 1, method: "tools/list" }, mockApi({}));
    expect(r.result.tools.map((t: any) => t.name)).toEqual([
      "plan_arrive_by", "plan_depart_at", "next_departures", "stop_search",
      "line_info", "disruptions", "shared_mobility", "car_park_availability",
    ]);
  });

  it("serves over HTTP", async () => {
    const res = await worker.fetch(
      new Request("https://w/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }) }),
      {},
    );
    expect(((await res.json()) as any).result.serverInfo.name).toBe("m-reso-mcp");
  });

  it("plans arrive-by and picks latest departure", async () => {
    const mk = (s: number, e: number) => ({
      startTime: s, endTime: e, duration: (e - s) / 1000, transfers: 0,
      legs: [{ transitLeg: true, mode: "TRAM", routeShortName: "A", headsign: "Fontaine", from: { name: "Chavant", departure: s },
        to: { name: "Gare", arrival: e }, startTime: s, endTime: e, intermediateStops: [{ name: "Hubert", departure: s + 60000 }] }],
    });
    const t = Date.parse("2026-11-03T17:00:00Z");
    const api = mockApi({
      "/routers/default/index/clusters/SEM:A": { name: "A", lat: 45.1, lon: 5.7 },
      "/routers/default/index/clusters/SEM:B": { name: "B", lat: 45.2, lon: 5.8 },
      "/routers/default/plan": { plan: { itineraries: [mk(t - 600000, t - 60000), mk(t - 300000, t - 30000)] } },
    });
    const r = await call(api, "plan_arrive_by", { from_stop: "SEM:A", to_stop: "SEM:B", arrive_by: "2026-11-03T18:30" });
    const out = JSON.parse(r.result.content[0].text);
    expect(out.latest_departure.departs).toBe("2026-11-03T17:55");
    expect(out.latest_departure.legs[0].stops_along_the_way).toHaveLength(1);
  });

  it("reports API errors as tool errors", async () => {
    const r = await call(mockApi({}), "next_departures", { stop: "SEM:X" });
    expect(r.result.isError).toBe(true);
  });
});
