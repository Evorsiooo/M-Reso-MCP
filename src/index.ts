import { MApi } from "./api";
import { handleMcp } from "./mcp";

export interface Env {
  MOBILITES_API_BASE?: string;
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type, mcp-session-id, mcp-protocol-version, authorization",
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    if (url.pathname === "/mcp") {
      if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { ...CORS, allow: "POST" } });
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400, headers: CORS });
      }
      const result = await handleMcp(body, new MApi(env.MOBILITES_API_BASE));
      if (result === null) return new Response(null, { status: 202, headers: CORS });
      return Response.json(result, { headers: CORS });
    }

    return Response.json(
      { name: "m-reso-mcp", description: "MCP server for Grenoble transport (Mobilités M)", mcp_endpoint: `${url.origin}/mcp` },
      { headers: CORS },
    );
  },
} satisfies ExportedHandler<Env>;
