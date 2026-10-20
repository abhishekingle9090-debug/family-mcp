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

// 2. Build the MCP server with three tools
function buildServer(): McpServer {
  const server = new McpServer({
    name: "family-assistant",
    version: "1.0.0",
  });

  // Tool 1: check inventory
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

  // Tool 2: find available slots
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

  // Tool 3: book delivery (requires explicit confirmation)
  server.tool(
    "book_delivery",
    "Book a delivery slot. Only call this AFTER the user has explicitly confirmed the booking.",
    {
      item: z.string().describe("Item to be delivered"),
      date: z.string().describe("Date in YYYY-MM-DD format"),
      time: z.string().describe("Time in HH:MM format"),
      confirmed: z
        .boolean()
        .describe("Must be true only after the user has said yes to the booking"),
    },
    async ({ item, date, time, confirmed }) => {
      if (confirmed !== true) {
        return {
          content: [
            {
              type: "text",
              text: `Confirmation required. Ask the user: "Shall I book ${item} for ${date} at ${time}?" Do not retry until they say yes.`,
            },
          ],
        };
      }

      await db.execute({
        sql: "INSERT INTO appointments (date, time, status) VALUES (?, ?, ?)",
        args: [date, time, `delivery: ${item}`],
      });

      return {
        content: [
          {
            type: "text",
            text: `Booked delivery for ${item} on ${date} at ${time}.`,
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