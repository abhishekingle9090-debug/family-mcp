import "dotenv/config";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createClient } from "@libsql/client";
import { z } from "zod";
import OpenAI from "openai";

const db = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN!,
});

const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY!,
  baseURL: "https://api.groq.com/openai/v1",
});

// ---------- MCP server (tools with structuredContent) ----------
function buildServer(): McpServer {
  const server = new McpServer({ name: "family-assistant", version: "1.0.0" });

  server.tool(
    "check_inventory",
    "Check inventory for items below their low-stock threshold.",
    {},
    async () => {
      const rs = await db.execute(
        "SELECT item_name, quantity, threshold FROM inventory WHERE quantity <= threshold"
      );
      const items = rs.rows.map((r) => ({
        name: String(r.item_name),
        quantity: Number(r.quantity),
        threshold: Number(r.threshold),
      }));

      const text = items.length
        ? `Low stock: ${items.map((i) => `${i.name} (qty: ${i.quantity}, threshold: ${i.threshold})`).join(", ")}`
        : "All items are sufficiently stocked.";

      return {
        content: [{ type: "text", text }],
        structuredContent: {
          type: "inventory_alert",
          items,
          hasLowStock: items.length > 0,
        },
      };
    }
  );

  server.tool(
    "find_available_slots",
    "Find available appointment slots on a given date.",
    { date: z.string().describe("Date in YYYY-MM-DD format") },
    async ({ date }) => {
      const slots = ["10:00", "14:00", "16:00"];
      return {
        content: [{ type: "text", text: `Available slots on ${date}: ${slots.join(", ")}` }],
        structuredContent: {
          type: "slot_picker",
          date,
          slots,
        },
      };
    }
  );

  server.tool(
    "book_delivery",
    "Book a delivery slot. Only call this AFTER the user has explicitly confirmed.",
    {
      item: z.string(),
      date: z.string(),
      time: z.string(),
      confirmed: z.boolean().describe("Must be true only after the user said yes"),
    },
    async ({ item, date, time, confirmed }) => {
      if (confirmed !== true) {
        return {
          content: [
            {
              type: "text",
              text: `Confirmation required. Ask the user: "Shall I book ${item} for ${date} at ${time}?"`,
            },
          ],
        };
      }
      await db.execute({
        sql: "INSERT INTO appointments (date, time, status) VALUES (?, ?, ?)",
        args: [date, time, `delivery: ${item}`],
      });
      return {
        content: [{ type: "text", text: `Booked delivery for ${item} on ${date} at ${time}.` }],
        structuredContent: {
          type: "booking_confirmation",
          item,
          date,
          time,
          status: "confirmed",
        },
      };
    }
  );

  server.tool(
    "list_appointments",
    "List all booked appointments from the database.",
    {},
    async () => {
      const rs = await db.execute(
        "SELECT date, time, status FROM appointments ORDER BY date, time"
      );
      const rows = rs.rows.map((r) => `${r.date} ${r.time} — ${r.status}`);
      return {
        content: [
          {
            type: "text",
            text: rows.length ? rows.join("\n") : "No appointments booked.",
          },
        ],
      };
    }
  );

  return server;
}

// ---------- Express app ----------
const app = express();
app.use(express.json());
app.use(express.static("public"));

app.post("/mcp", async (req, res) => {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
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

// ---------- LLM tool definitions ----------
const LLM_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "check_inventory",
      description: "Check inventory for items below their low-stock threshold.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "find_available_slots",
      description: "Find available slots on a date.",
      parameters: {
        type: "object",
        properties: { date: { type: "string" } },
        required: ["date"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "book_delivery",
      description: "Book a delivery. Only with explicit user confirmation.",
      parameters: {
        type: "object",
        properties: {
          item: { type: "string" },
          date: { type: "string" },
          time: { type: "string" },
          confirmed: { type: "boolean" },
        },
        required: ["item", "date", "time", "confirmed"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "list_appointments",
      description: "List all booked appointments.",
      parameters: { type: "object", properties: {} },
    },
  },
];

const SYSTEM_PROMPT = `Current date: ${new Date().toISOString().split("T")[0]}.
You are a proactive family caretaker assistant.

Flow:
1. On any help request, call check_inventory.
2. If items are low, call find_available_slots for today's date.
3. Reply briefly, naming the low item, proposing ONE slot, and asking "Shall I book it?".
4. Wait for explicit "yes". Only then call book_delivery with confirmed=true.
5. If asked what's booked, call list_appointments.

Rules:
- Never call book_delivery with confirmed=true without explicit user yes.
- If any tool errors, tell the user it failed. Never claim success.
- Only say "booked" if book_delivery returned a result starting with "Booked".
- Keep replies short and warm.`;

let conversation: any[] = [];

async function callMcp(name: string, args: any): Promise<{ text: string; structured: any }> {
  const client = new Client({ name: "self", version: "1.0" }, { capabilities: {} });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://localhost:8081/mcp"))
  );
  try {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as any[]).map((c) => c.text || "").join("\n");
    const structured = (result as any).structuredContent || null;
    return { text, structured };
  } finally {
    await client.close();
  }
}

app.post("/chat", async (req, res) => {
  const { message } = req.body;
  if (!message || typeof message !== "string") {
    return res.status(400).json({ error: "message required" });
  }

  conversation.push({ role: "user", content: message });
  const trace: any[] = [];
  const cards: any[] = [];

  try {
    for (let turn = 0; turn < 6; turn++) {
      const response = await groq.chat.completions.create({
        model: "openai/gpt-oss-120b",
        messages: [{ role: "system", content: SYSTEM_PROMPT }, ...conversation],
        tools: LLM_TOOLS as any,
        tool_choice: "auto",
        temperature: 0.3,
        include_reasoning: false,
      });
      const msg = response.choices[0].message;
      conversation.push(msg);

      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        return res.json({ reply: msg.content || "", trace, cards });
      }

      for (const call of msg.tool_calls) {
        const args = JSON.parse(call.function.arguments || "{}");
        const { text, structured } = await callMcp(call.function.name, args);
        trace.push({ tool: call.function.name, args, result: text });
        if (structured) cards.push(structured);
        conversation.push({ role: "tool", tool_call_id: call.id, content: text });
      }
    }
    return res.json({ reply: "I couldn't finish that. Try rephrasing.", trace, cards });
  } catch (e: any) {
    return res.status(500).json({ error: e.message, trace });
  }
});

app.post("/reset", (_req, res) => {
  conversation = [];
  res.json({ ok: true });
});

const PORT = process.env.PORT || 8081;
app.listen(PORT, () => {
  console.log(`MCP + web UI on http://localhost:${PORT}`);
});