import { MApi } from "./api";
import { tools } from "./tools";

const PROTOCOL = "2025-03-26";
type Req = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: any };

const ok = (id: any, result: unknown) => ({ jsonrpc: "2.0", id, result });
const err = (id: any, code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

async function handle(r: Req, api: MApi) {
  const isNotification = r.id === undefined;
  switch (r.method) {
    case "initialize":
      return ok(r.id, {
        protocolVersion: PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: "m-reso-mcp", version: "0.2.0" },
        instructions: "Grenoble public transport (Mobilités M). Use stop_search first to get stop IDs.",
      });
    case "ping":
      return ok(r.id, {});
    case "tools/list":
      return ok(r.id, { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case "tools/call": {
      const tool = tools.find((t) => t.name === r.params?.name);
      if (!tool) return err(r.id, -32602, `Unknown tool: ${r.params?.name}`);
      try {
        const result = await tool.handler(r.params?.arguments ?? {}, api);
        return ok(r.id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
      } catch (e: any) {
        return ok(r.id, { isError: true, content: [{ type: "text", text: String(e?.message ?? e) }] });
      }
    }
    default:
      return isNotification ? null : err(r.id, -32601, `Method not found: ${r.method}`);
  }
}

export async function handleMcp(body: unknown, api: MApi): Promise<unknown | null> {
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map((b) => handleOne(b, api)))).filter((x) => x !== null);
    return out.length ? out : null;
  }
  return handleOne(body, api);
}

async function handleOne(b: any, api: MApi) {
  if (!b || b.jsonrpc !== "2.0" || typeof b.method !== "string") return err(b?.id, -32600, "Invalid request");
  if (b.id === undefined && b.method.startsWith("notifications/")) return null;
  return handle(b, api);
}
