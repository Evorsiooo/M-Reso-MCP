import { MApi } from "./api";
import { hhmm, localIso, toLocalDateTime } from "./time";

export interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: any, api: MApi) => Promise<unknown>;
}

const str = (description: string) => ({ type: "string", description });
const num = (description: string) => ({ type: "number", description });
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object", properties, required, additionalProperties: false,
});

const STOP_HINT =
  "Stop ID as returned by stop_search (e.g. SEM:GENCHAVANT), or coordinates as 'lat,lon'.";

/* ---------- helpers ---------- */

const lineOfPattern = (patternId: string | undefined) => {
  // pattern ids look like "SEM:A:1:1" -> route id "SEM:A"
  const p = (patternId ?? "").split(":");
  return p.length >= 2 ? `${p[0]}:${p[1]}` : patternId ?? "";
};

async function resolvePlace(api: MApi, input: string): Promise<string> {
  const s = String(input).trim();
  if (/^-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?$/.test(s)) return s.replace(/\s+/g, "");
  const c: any = await api.get(`/routers/default/index/clusters/${encodeURIComponent(s)}`);
  if (c?.lat == null || c?.lon == null) throw new Error(`Unknown stop "${s}". Use stop_search to find stop IDs.`);
  return `${String(c.name ?? s).replace(/:/g, " ")}::${c.lat},${c.lon}`;
}

const timeOf = (p: any, key: "start" | "end") => (key === "start" ? p.departure ?? p.startTime : p.arrival ?? p.endTime);

function summariseItinerary(it: any) {
  return {
    departs: localIso(it.startTime),
    arrives: localIso(it.endTime),
    duration_min: Math.round(it.duration / 60),
    transfers: it.transfers,
    legs: (it.legs ?? []).map((l: any) => {
      const base = {
        mode: l.mode,
        from: { name: l.from?.name, time: hhmm(timeOf(l.from ?? {}, "start") ?? l.startTime) },
        to: { name: l.to?.name, time: hhmm(timeOf(l.to ?? {}, "end") ?? l.endTime) },
      };
      if (!l.transitLeg) return { ...base, distance_m: Math.round(l.distance ?? 0), duration_min: Math.round((l.duration ?? 0) / 60) };
      return {
        ...base,
        line: l.routeShortName ?? l.route,
        line_id: l.routeId,
        headsign: l.headsign,
        realtime: !!l.realTime,
        stops_along_the_way: (l.intermediateStops ?? []).map((s: any) => ({
          name: s.name,
          time: hhmm(s.departure ?? s.arrival),
        })),
      };
    }),
  };
}

async function plan(api: MApi, a: any, arriveBy: boolean) {
  const [from, to] = await Promise.all([resolvePlace(api, a.from_stop), resolvePlace(api, a.to_stop)]);
  const { date, time } = toLocalDateTime(arriveBy ? a.arrive_by : a.depart_at);
  const data: any = await api.get("/routers/default/plan", {
    fromPlace: from, toPlace: to, date, time, arriveBy,
    mode: "TRANSIT,WALK",
    numItineraries: arriveBy ? 6 : Math.min(Math.max(a.max_options ?? 4, 1), 8),
    maxWalkDistance: a.max_walk_m ?? 1000,
  });
  const its: any[] = data?.plan?.itineraries ?? [];
  if (!its.length) {
    return { found: false, message: data?.error?.msg ?? "No journey found.", requested: { date, time } };
  }
  if (arriveBy) {
    // Only keep options that really arrive on time; best = latest departure.
    const ok = its.filter((i) => localIso(i.endTime) <= `${date}T${time}`);
    const sorted = (ok.length ? ok : its).sort((x, y) => y.startTime - x.startTime);
    return {
      found: true,
      requested_arrival: `${date}T${time}`,
      latest_departure: summariseItinerary(sorted[0]),
      alternatives: sorted.slice(1, 4).map(summariseItinerary),
    };
  }
  return { found: true, requested_departure: `${date}T${time}`, options: its.map(summariseItinerary) };
}

/* ---------- tools ---------- */

export const tools: Tool[] = [
  {
    name: "plan_arrive_by",
    description:
      "Find the latest departure that still arrives at the alighting stop by a given time. Returns line, boarding stop and time, alighting stop and time, and the stop times along the way. Times are Grenoble local time.",
    inputSchema: obj({
      from_stop: str(`Boarding stop. ${STOP_HINT}`),
      to_stop: str(`Alighting stop. ${STOP_HINT}`),
      arrive_by: str("Latest acceptable arrival, ISO local time like 2026-11-03T18:30, or HH:mm for today."),
      max_walk_m: num("Max walking distance in metres (default 1000)."),
    }, ["from_stop", "to_stop", "arrive_by"]),
    handler: (a, api) => plan(api, a, true),
  },
  {
    name: "plan_depart_at",
    description: "Journey options from one stop to another for a given departure time. Times are Grenoble local time.",
    inputSchema: obj({
      from_stop: str(`Boarding stop. ${STOP_HINT}`),
      to_stop: str(`Alighting stop. ${STOP_HINT}`),
      depart_at: str("Earliest departure, ISO local time like 2026-11-03T08:15, or HH:mm for today."),
      max_options: num("Number of options (1-8, default 4)."),
      max_walk_m: num("Max walking distance in metres (default 1000)."),
    }, ["from_stop", "to_stop", "depart_at"]),
    handler: (a, api) => plan(api, a, false),
  },
  {
    name: "next_departures",
    description: "Next departures at a stop with line, destination and real-time times.",
    inputSchema: obj({
      stop: str("Stop (cluster) ID from stop_search, e.g. SEM:GENCHAVANT."),
      line: str("Optional line ID to filter on, e.g. SEM:A."),
      count: num("Number of departures per pattern to fetch (default 6)."),
    }, ["stop"]),
    handler: async (a, api) => {
      const data: any[] = await api.get(`/routers/default/index/clusters/${encodeURIComponent(a.stop)}/stoptimes`, {
        numberOfDepartures: a.count ?? 6,
      });
      const out: any[] = [];
      for (const p of data ?? []) {
        const line = lineOfPattern(p.pattern?.id);
        if (a.line && line !== a.line) continue;
        for (const t of p.times ?? []) {
          const secs = t.realtimeDeparture ?? t.scheduledDeparture;
          const sched = t.scheduledDeparture;
          const ms = (t.serviceDay + secs) * 1000;
          out.push({
            line,
            destination: p.pattern?.lastStop ?? p.pattern?.desc,
            pattern: p.pattern?.desc,
            stop: t.stopName,
            time: hhmm(ms),
            scheduled: hhmm((t.serviceDay + sched) * 1000),
            delay_min: Math.round((secs - sched) / 60),
            realtime: !!t.realtime,
            _ms: ms,
          });
        }
      }
      out.sort((x, y) => x._ms - y._ms);
      return { stop: a.stop, departures: out.map(({ _ms, ...r }) => r) };
    },
  },
  {
    name: "stop_search",
    description: "Find stop IDs by name (e.g. 'chavant', 'gare grenoble').",
    inputSchema: obj({ query: str("Stop name or part of it."), limit: num("Max results (default 10).") }, ["query"]),
    handler: async (a, api) => {
      const data: any = await api.get("/findType/json", { types: "arret", query: a.query });
      const feats: any[] = data?.features ?? [];
      return {
        stops: feats.slice(0, a.limit ?? 10).map((f) => ({
          id: f.properties?.id ?? f.properties?.code,
          name: f.properties?.LIBELLE ?? f.properties?.name,
          city: f.properties?.COMMUNE ?? f.properties?.city,
          lat: f.geometry?.coordinates?.[1],
          lon: f.geometry?.coordinates?.[0],
          lines: f.properties?.lignes ?? f.properties?.LIGNES,
        })),
      };
    },
  },
  {
    name: "line_info",
    description:
      "Information on a line: its stops and timetable, or the PDF timetable link. Line IDs look like SEM:A, SEM:C1, SMMAG:67.",
    inputSchema: obj({
      line: str("Line ID, e.g. SEM:A."),
      kind: { type: "string", enum: ["stops", "timetable", "pdf"], description: "What to return (default: stops)." },
    }, ["line"]),
    handler: async (a, api) => {
      const kind = a.kind ?? "stops";
      if (kind === "pdf") return { line: a.line, pdf_url: api.url("/ficheHoraires/pdf", { route: a.line }) };
      if (kind === "timetable") return { line: a.line, timetable: await api.get("/ficheHoraires/json", { route: a.line }) };
      const [routes, stops]: any[] = await Promise.all([
        api.get("/routers/default/index/routes", { codes: a.line }).catch(() => []),
        api.get(`/routers/default/index/routes/${encodeURIComponent(a.line)}/clusters`),
      ]);
      const r = Array.isArray(routes) ? routes[0] : undefined;
      return {
        line: a.line,
        name: r?.longName ?? r?.shortName,
        stops: (stops ?? []).map((s: any) => ({ id: s.code ?? s.id, name: s.name, lat: s.lat, lon: s.lon })),
      };
    },
  },
  {
    name: "disruptions",
    description: "Current service alerts for the whole network, or for one line.",
    inputSchema: obj({ line: str("Optional line ID, e.g. SEM:A.") }),
    handler: async (a, api) => {
      const data: any = await api.get("/dyn/evtTC/json");
      let events: any[] = Array.isArray(data) ? data : data?.evtTC ?? data?.events ?? data?.features ?? [];
      if (a.line) {
        const needle = String(a.line).toLowerCase();
        events = events.filter((e) => JSON.stringify(e).toLowerCase().includes(needle));
      }
      return { count: events.length, disruptions: events };
    },
  },
  {
    name: "shared_mobility",
    description:
      "Shared bikes and scooters (Métrovélo and other docked/free-floating systems) and their availability near a point.",
    inputSchema: obj({
      lat: num("Latitude."),
      lon: num("Longitude."),
      radius_m: num("Search radius in metres (default 500)."),
      types: str("Comma-separated API object types (default 'MVC,MVA,CIT,VLS' – bike stations, cars, etc.)."),
    }, ["lat", "lon"]),
    handler: async (a, api) => {
      const data: any = await api.get("/bbox/json", {
        x: a.lon, y: a.lat, dist: a.radius_m ?? 500, types: a.types ?? "MVC,MVA,CIT,VLS",
      });
      return {
        results: (data?.features ?? []).map((f: any) => ({
          ...f.properties,
          lat: f.geometry?.coordinates?.[1],
          lon: f.geometry?.coordinates?.[0],
        })),
      };
    },
  },
  {
    name: "car_park_availability",
    description: "Real-time free spaces at P+R car parks.",
    inputSchema: obj({ name: str("Optional name filter, e.g. 'Gières'.") }),
    handler: async (a, api) => {
      const data: any = await api.get("/dyn/PAR/json");
      let rows: any[] = (data?.features ?? []).map((f: any) => ({
        ...f.properties,
        lat: f.geometry?.coordinates?.[1],
        lon: f.geometry?.coordinates?.[0],
      }));
      if (a.name) {
        const n = String(a.name).toLowerCase();
        rows = rows.filter((r) => JSON.stringify(r).toLowerCase().includes(n));
      }
      return { car_parks: rows };
    },
  },
];
