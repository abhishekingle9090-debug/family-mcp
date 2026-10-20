import "dotenv/config";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createClient } from "@libsql/client";
import { z } from "zod";

// 1. Connect to Turso
const db = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN!,
});

// 2. Build the MCP server with two read-only tools
function buildServer(): McpServer {
  const server = new McpServer({
    name: "family-assistant",
    version: "1.0.0",
  });

  // Tool 1: check inventory for low-stock items
  server.tool(
    "check_inventory",
    "Check inventory for items below their low-stock threshold.",
    {},
    async () => {
      const rs = await db.execute(
        "SELECT item_name, quantity, threshold FROM inventory WHERE quantity <= threshold"
      );
      const items = rs.rows.map(
        (r) => `${r.item_name} (qty: ${r.quantity}, threshold: ${r.threshold})`
      );
      return {
        content: [
          {
            type: "text",
            text: items.length
              ? `Low stock: ${items.join(", ")}`
              : "All items are sufficiently stocked.",
          },
        ],
      };
    }
  );

  // Tool 2: find available appointment slots on a given date
  server.tool(
    "find_available_slots",
    "Find available appointment slots on a given date.",
    { date: z.string().describe("Date in YYYY-MM-DD format") },
    async ({ date }) => {
      const slots = ["10:00", "14:00", "16:00"];
      return {
        content: [
          {
            type: "text",
            text: `Available slots on ${date}: ${slots.join(", ")}`,
          },
        ],
      };
    }
  );

  return server;
}

// 3. HTTP server using Streamable HTTP in stateless mode
const app = express();
app.use(express.json());

app.post("/mcp", async (req, res) => {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
  });

  res.on("close", () => {
    transport.close();
    server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.get("/mcp", (_req, res) => res.status(405).end());
app.delete("/mcp", (_req, res) => res.status(405).end());

const PORT = process.env.PORT || 8081;
app.listen(PORT, () => {
  console.log(`MCP server listening on http://localhost:${PORT}/mcp`);
});