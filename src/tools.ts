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
  "Coordinates 'lat,lon' (from stop_search) or a stop name such as 'Chavant'.";

/* ---------- helpers ---------- */

const lineOfPattern = (patternId: string | undefined) => {
  // pattern ids look like "SEM:A:1:1" -> route id "SEM:A"
  const p = (patternId ?? "").split(":");
  return p.length >= 2 ? `${p[0]}:${p[1]}` : patternId ?? "";
};

const COORDS = /^-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?$/;

const norm = (x: string) => x.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

/** The API matches the exact phrase only; if that finds nothing, search word by word and rank by words matched. */
async function searchClusters(api: MApi, query: string) {
  const visible = (d: any) => ((d?.features ?? []) as any[]).filter((f) => f.properties?.visible !== false);
  const full = visible(await api.get("/findType/json", { types: "clusters", query }));
  if (full.length) return full;
  const words = norm(query).split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
  if (words.length < 2) return [];
  const byId = new Map<string, any>();
  for (const w of words) for (const f of visible(await api.get("/findType/json", { types: "clusters", query: w }))) byId.set(f.properties.id, f);
  const score = (f: any) => words.filter((w) => norm(`${f.properties.name} ${f.properties.city}`).includes(w)).length;
  return [...byId.values()].sort((x, y) => score(y) - score(x)).filter((f) => score(f) > 0);
}

/** The planner needs coordinates: accept "lat,lon" or a stop name (resolved through stop search). */
async function resolvePlace(api: MApi, input: string): Promise<{ place: string; label: string }> {
  const s = String(input).trim();
  if (COORDS.test(s)) return { place: s.replace(/\s+/g, ""), label: s };
  if (/^[A-Z0-9]+:[A-Z0-9_]+$/i.test(s)) {
    throw new Error(`The planner needs coordinates, not the ID "${s}". Pass "lat,lon" from stop_search, or the stop name.`);
  }
  const hits = await searchClusters(api, s);
  const f = hits[0];
  if (!f) throw new Error(`No stop found for "${s}". Try stop_search.`);
  const [lon, lat] = f.geometry.coordinates;
  return { place: `${lat},${lon}`, label: `${f.properties.name} (${f.properties.city})` };
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
        from: { name: l.from?.vertexType === "NORMAL" && l.from?.name === "Origin" ? undefined : l.from?.name, time: hhmm(timeOf(l.from ?? {}, "start") ?? l.startTime) },
        to: { name: l.to?.name === "Destination" ? undefined : l.to?.name, time: hhmm(timeOf(l.to ?? {}, "end") ?? l.endTime) },
      };
      if (!l.transitLeg) return { ...base, distance_m: Math.round(l.distance ?? 0), duration_min: Math.round((l.duration ?? 0) / 60) };
      return {
        ...base,
        line: l.routeShortName ?? l.route,
        line_id: `${String(l.agencyId ?? "SEM:SEM").split(":")[0]}:${l.routeShortName}`,
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
  const [fromR, toR] = await Promise.all([resolvePlace(api, a.from_stop), resolvePlace(api, a.to_stop)]);
  const from = fromR.place, to = toR.place;
  const resolved = { from: fromR.label, to: toR.label };
  const { date, time } = toLocalDateTime(arriveBy ? a.arrive_by : a.depart_at);
  const data: any = await api.get("/routers/default/plan", {
    fromPlace: from, toPlace: to, date, time, arriveBy,
    mode: "TRANSIT,WALK",
    showIntermediateStops: true,
    numItineraries: arriveBy ? 6 : Math.min(Math.max(a.max_options ?? 4, 1), 8),
    maxWalkDistance: a.max_walk_m ?? 1000,
  });
  const its: any[] = data?.plan?.itineraries ?? [];
  if (!its.length) {
    return { found: false, resolved, message: data?.error?.message ?? data?.error?.msg ?? "No journey found.", requested: { date, time } };
  }
  if (arriveBy) {
    // Only keep options that really arrive on time; best = latest departure.
    const ok = its.filter((i) => localIso(i.endTime) <= `${date}T${time}`);
    const sorted = (ok.length ? ok : its).sort((x, y) => y.startTime - x.startTime);
    return {
      found: true,
      resolved,
      requested_arrival: `${date}T${time}`,
      latest_departure: summariseItinerary(sorted[0]),
      alternatives: sorted.slice(1, 4).map(summariseItinerary),
    };
  }
  return { found: true, resolved, requested_departure: `${date}T${time}`, options: its.map(summariseItinerary) };
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
      stop: str("Stop (cluster) ID or code from stop_search, e.g. SEM:CHV or SEM:GENCHV."),
      line: str("Optional line ID to filter on, e.g. SEM:A."),
      count: num("Max departures to return (default 8)."),
    }, ["stop"]),
    handler: async (a, api) => {
      // The stoptimes endpoint wants the cluster *code* (SEM:GENCHV); stop_search ids look like SEM:CHV.
      const id = String(a.stop);
      const candidates = /^SEM:(?!GEN)/.test(id) ? [id.replace(/^SEM:/, "SEM:GEN"), id] : [id];
      let data: any[] | null = null;
      for (const c of candidates) {
        data = await api.get(`/routers/default/index/clusters/${encodeURIComponent(c)}/stoptimes`);
        if (data?.length) break;
      }
      const nowS = Date.now() / 1000;
      const out: any[] = [];
      for (const p of data ?? []) {
        const line = lineOfPattern(p.pattern?.id);
        if (a.line && line !== a.line) continue;
        for (const t of p.times ?? []) {
          const secs = t.realtimeDeparture ?? t.scheduledDeparture;
          if (t.serviceDay + secs < nowS - 30) continue;
          out.push({
            line,
            destination: p.pattern?.lastStopName ?? p.pattern?.desc,
            stop: t.stopName,
            time: hhmm((t.serviceDay + secs) * 1000),
            scheduled: hhmm((t.serviceDay + t.scheduledDeparture) * 1000),
            delay_min: Math.round((secs - t.scheduledDeparture) / 60),
            realtime: !!t.realtime,
            _s: t.serviceDay + secs,
          });
        }
      }
      out.sort((x, y) => x._s - y._s);
      return { stop: id, departures: out.slice(0, a.count ?? 8).map(({ _s, ...r }) => r) };
    },
  },
  {
    name: "stop_search",
    description:
      "Find stops by name (e.g. 'chavant', 'gare grenoble'). Returns the stop ID/code (for next_departures and line_info) and coordinates (for the planners).",
    inputSchema: obj({ query: str("Stop name or part of it."), limit: num("Max results (default 10).") }, ["query"]),
    handler: async (a, api) => {
      const feats = await searchClusters(api, a.query);
      return {
        stops: feats.slice(0, a.limit ?? 10).map((f) => ({
          id: f.properties.id,
          code: f.properties.code,
          name: f.properties.name,
          city: f.properties.city,
          lat: f.geometry?.coordinates?.[1],
          lon: f.geometry?.coordinates?.[0],
          coordinates: `${f.geometry?.coordinates?.[1]},${f.geometry?.coordinates?.[0]}`,
        })),
      };
    },
  },
  {
    name: "line_info",
    description:
      "Information on a line: its stops, its timetable, or the PDF timetable link. Line IDs look like SEM:A, SEM:C1, SEM:25.",
    inputSchema: obj({
      line: str("Line ID, e.g. SEM:A."),
      kind: { type: "string", enum: ["stops", "timetable", "pdf"], description: "What to return (default: stops)." },
    }, ["line"]),
    handler: async (a, api) => {
      const kind = a.kind ?? "stops";
      if (kind === "pdf") return { line: a.line, pdf_url: api.url("/ficheHoraires/pdf", { route: a.line }) };
      if (kind === "timetable") {
        const t: any = await api.get("/ficheHoraires/json", { route: a.line });
        // Compact: per direction, per stop, departure times as HH:mm.
        const hm = (s: number) => `${String(Math.floor(s / 3600) % 24).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}`;
        return {
          line: a.line,
          directions: Object.values(t ?? {}).map((d: any) => ({
            stops: (d.arrets ?? []).map((s: any) => ({ name: s.stopName, times: (s.trips ?? []).map((x: number) => (x < 0 ? null : hm(x))) })),
          })),
          note: "Times are for the current service day; use pdf for the printable timetable.",
        };
      }
      const [routes, stops]: any[] = await Promise.all([
        api.get("/routers/default/index/routes", { codes: a.line }).catch(() => null),
        api.get(`/routers/default/index/routes/${encodeURIComponent(a.line)}/clusters`),
      ]);
      const r = routes?.[0];
      return {
        line: a.line,
        short_name: r?.shortName,
        name: r?.longName,
        mode: r?.mode,
        stops: (stops ?? []).map((s: any) => ({ id: s.id, code: s.code, name: s.name, city: s.city, lat: s.lat, lon: s.lon })),
      };
    },
  },
  {
    name: "disruptions",
    description: "Current service alerts for the whole network, or for one line (e.g. SEM:A or just A).",
    inputSchema: obj({ line: str("Optional line ID, e.g. SEM:A.") }),
    handler: async (a, api) => {
      const data: Record<string, any> = (await api.get("/dyn/evtTC/json")) ?? {};
      const want = a.line ? String(a.line).replace(":", "_") : null;
      const wantBare = a.line ? `SEM_${String(a.line).replace(/^[A-Z0-9]+[:_]/, "")}` : null;
      const now = Date.now();
      const parse = (d: string) => {
        const m = String(d ?? "").match(/(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})/);
        return m ? Date.parse(`${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:00+01:00`) : NaN;
      };
      const list = Object.values(data)
        .filter((e: any) => {
          if (parse(e.dateDebut) > now + 3600_000 * 24) return false; // not yet relevant
          if (parse(e.dateFin) < now) return false;
          if (!want) return true;
          return String(e.listeLigne ?? "").split(",").map((x) => x.trim()).some((x) => x === want || x === wantBare);
        })
        .map((e: any) => ({
          title: e.titre, description: e.description, from: e.dateDebut, until: e.dateFin,
          lines: e.listeLigne, stops: e.listeArret, pdf: e.plan || undefined,
        }));
      return { count: list.length, disruptions: list };
    },
  },
  {
    name: "shared_mobility",
    description:
      "Shared scooters (Voi) and car-sharing stations (Citiz) near a point, with availability. Métrovélo bike lockers are not real-time and are not included.",
    inputSchema: obj({
      lat: num("Latitude."),
      lon: num("Longitude."),
      radius_m: num("Search radius in metres (default 500)."),
    }, ["lat", "lon"]),
    handler: async (a, api) => {
      const r = a.radius_m ?? 500;
      const dist = (lat: number, lon: number) => {
        const R = 6371000, rad = Math.PI / 180;
        const dLat = (lat - a.lat) * rad, dLon = (lon - a.lon) * rad;
        const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(lat * rad) * Math.sin(dLon / 2) ** 2;
        return Math.round(2 * R * Math.asin(Math.sqrt(h)));
      };
      const [voi, info, status]: any[] = await Promise.all([
        api.get("/gbfs/voi_grenoble/free_bike_status"),
        api.get("/gbfs/citiz_grenoble/station_information"),
        api.get("/gbfs/citiz_grenoble/station_status"),
      ]);
      const scooters = (voi?.data?.bikes ?? [])
        .filter((b: any) => !b.is_disabled && !b.is_reserved)
        .map((b: any) => ({ id: b.bike_id, lat: b.lat, lon: b.lon, distance_m: dist(b.lat, b.lon), battery_range_m: b.current_range_meters, rent_url: b.rental_uris?.ios }))
        .filter((b: any) => b.distance_m <= r)
        .sort((x: any, y: any) => x.distance_m - y.distance_m);
      const avail = new Map<string, number>((status?.data?.stations ?? []).map((s: any) => [s.station_id, s.num_vehicles_available]));
      const cars = (info?.data?.stations ?? [])
        .map((s: any) => ({
          name: s.name?.[0]?.text, address: s.address, lat: s.lat, lon: s.lon,
          distance_m: dist(s.lat, s.lon), vehicles_available: avail.get(s.station_id) ?? null,
        }))
        .filter((s: any) => s.distance_m <= r)
        .sort((x: any, y: any) => x.distance_m - y.distance_m);
      return { radius_m: r, scooters_voi: scooters.slice(0, 15), scooter_count: scooters.length, car_sharing_citiz: cars };
    },
  },
  {
    name: "car_park_availability",
    description: "Real-time free spaces at P+R car parks around Grenoble.",
    inputSchema: obj({ name: str("Optional name filter, e.g. 'Gières'.") }),
    handler: async (a, api) => {
      const [stat, dyn]: any[] = await Promise.all([
        api.get("/bbox/json", { xmin: 5.0, ymin: 44.8, xmax: 6.2, ymax: 45.6, types: "parking" }),
        api.get("/dyn/parking/json"),
      ]);
      let rows = ((stat?.features ?? []) as any[])
        .filter((f) => f.properties?.nb_pr > 0)
        .map((f) => {
          const p = f.properties, d = dyn?.[p.id];
          return {
            name: p.nom, city: p.commune, address: p.adresse, capacity: p.nb_pr,
            free_spaces: d?.nb_pr_libres ?? d?.nb_places_libres ?? null,
            updated: d?.time ? new Date(d.time).toISOString() : null,
            free: p.gratuit, lat: f.geometry?.coordinates?.[1], lon: f.geometry?.coordinates?.[0],
          };
        });
      if (a.name) rows = rows.filter((r) => norm(`${r.name} ${r.city ?? ""}`).includes(norm(String(a.name))));
      return { car_parks: rows, note: "free_spaces is null when the car park has no live counter." };
    },
  },
];
