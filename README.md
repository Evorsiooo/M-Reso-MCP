# M-Reso-MCP

A remote [MCP](https://modelcontextprotocol.io) server on Cloudflare Workers wrapping the
[Mobilités M open data API](https://data.mobilites-m.fr) (Grenoble public transport).
It holds no route or stop data: everything is passed in as a parameter and fetched live.

Endpoint: `https://<your-worker>.workers.dev/mcp` (Streamable HTTP, stateless JSON-RPC).

## Tools

| Tool | Purpose |
|---|---|
| `plan_arrive_by` | Latest departure that arrives by a given time (line, boarding/alighting stop + times, stops along the way) |
| `plan_depart_at` | Journey options for a departure time |
| `next_departures` | Next real-time departures at a stop |
| `stop_search` | Find stop IDs by name |
| `line_info` | Line stops, timetable JSON, or PDF timetable link |
| `disruptions` | Network or per-line alerts |
| `shared_mobility` | Shared bikes/scooters near a point |
| `car_park_availability` | Real-time free spaces at P+R car parks |

Times are Grenoble local time (Europe/Paris). Stops are IDs from `stop_search` (e.g. `SEM:GENCHAVANT`) or `lat,lon`.

## Develop

```bash
npm install
npm test
npm run dev      # local at http://localhost:8787/mcp
```

## Deploy (Cloudflare Workers Builds, from this repo)

Cloudflare dashboard → Workers & Pages → Create → Import a repository → select this repo, branch `main`.
Build command: *(none)*, deploy command: `npx wrangler deploy`. The Worker name must match `name` in `wrangler.jsonc` (`m-reso-mcp`).
Every push to `main` then deploys automatically.
