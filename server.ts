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

const notifiedItems = new Set<string>();

// ---------- MCP server (tools) ----------
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
        structuredContent: { type: "inventory_alert", items, hasLowStock: items.length > 0 },
      };
    }
  );

  server.tool(
    "find_available_slots",
    "Find available appointment slots on a given date.",
    { date: z.string().describe("Date in YYYY-MM-DD format") },
    async ({ date }) => {
      const rs = await db.execute({
        sql: "SELECT time FROM availability WHERE date = ? AND is_booked = 0 ORDER BY time",
        args: [date],
      });
      const slots = rs.rows.map((r) => String(r.time));
      const text = slots.length
        ? `Available slots on ${date}: ${slots.join(", ")}`
        : `No available slots on ${date}. All slots are booked.`;
      return {
        content: [{ type: "text", text }],
        structuredContent: { type: "slot_picker", date, slots },
      };
    }
  );

  server.tool(
    "check_weather",
    "Check the weather forecast for a city and date to decide if delivery is safe today.",
    {
      city: z.string().describe("City name like Mumbai"),
      date: z.string().describe("Date in YYYY-MM-DD format"),
    },
    async ({ city, date }) => {
      try {
        const geoRes = await fetch(
          `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1`
        );
        const geoData: any = await geoRes.json();
        if (!geoData.results || geoData.results.length === 0) {
          return {
            content: [{ type: "text", text: `Could not find city "${city}".` }],
          };
        }
        const lat = geoData.results[0].latitude;
        const lon = geoData.results[0].longitude;

        const weatherRes = await fetch(
          `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=precipitation_probability_max,weathercode&start_date=${date}&end_date=${date}&timezone=auto`
        );
        const weatherData: any = await weatherRes.json();
        const rain = weatherData.daily?.precipitation_probability_max?.[0] ?? 0;
        const code = weatherData.daily?.weathercode?.[0] ?? 0;
        const isRainy = rain > 50 || code >= 51;

        const summary = isRainy
          ? `Rain likely on ${date} in ${city} (${rain}% chance).`
          : `Weather looks fine on ${date} in ${city} (${rain}% rain chance).`;

        return {
          content: [{ type: "text", text: summary }],
          structuredContent: {
            type: "weather_forecast",
            city,
            date,
            rainChance: rain,
            isRainy,
            summary,
          },
        };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `Weather check failed: ${e.message}` }],
        };
      }
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

      const itemCheck = await db.execute({
        sql: "SELECT item_name FROM inventory WHERE LOWER(item_name) = LOWER(?)",
        args: [item],
      });
      if (itemCheck.rows.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `Rejected: "${item}" is not in the inventory. I can only book items that exist in the system.`,
            },
          ],
        };
      }

      const today = new Date().toISOString().split("T")[0];
      if (date < today) {
        return {
          content: [
            {
              type: "text",
              text: `Rejected: ${date} is in the past. Today is ${today}. I can only book future dates.`,
            },
          ],
        };
      }

      const slotCheck = await db.execute({
        sql: "SELECT time FROM availability WHERE date = ? AND time = ? AND is_booked = 0",
        args: [date, time],
      });
      if (slotCheck.rows.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `Rejected: ${date} at ${time} is not available. It may be booked or outside business hours.`,
            },
          ],
        };
      }

      await db.execute({
        sql: "INSERT INTO appointments (date, time, status) VALUES (?, ?, ?)",
        args: [date, time, `delivery: ${item}`],
      });
      await db.execute({
        sql: "UPDATE availability SET is_booked = 1 WHERE date = ? AND time = ?",
        args: [date, time],
      });

      notifiedItems.delete(item);

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
      name: "check_weather",
      description: "Check if weather is safe for delivery on a given date. Call before proposing slots.",
      parameters: {
        type: "object",
        properties: {
          city: { type: "string" },
          date: { type: "string" },
        },
        required: ["city", "date"],
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

LANGUAGE:
- Reply in the same language the user used. If they wrote in Hindi (Devanagari or Roman Hindi like "Tylenol low hai, book kar do"), reply in natural Hindi. Otherwise reply in English.
- Keep replies short, warm, and natural in whichever language you use.

STRICT TOOL ORDER (do not skip):
When responding to a greeting or a delivery request, you MUST call the tools in this exact order:
  1. check_inventory
  2. check_weather (ALWAYS, no exceptions — use "Mumbai" as the city if unknown, and today's date)
  3. find_available_slots (for today, or tomorrow if weather says rain > 50%)
  4. reply with a proposal and ask for confirmation (in the user's language)
Never call find_available_slots before check_weather. If you skip check_weather, the response is invalid.

WEATHER-AWARE DELIVERY:
- If check_weather returns rain chance > 50%, propose TOMORROW's slot instead of today, and tell the user the reason.
- If weather is fine, propose today's slots normally.

CONFIRMATION FLOW:
- After proposing a slot, WAIT for explicit confirmation from the user (yes / haan / theek hai / book karo).
- Only after the user confirms, call book_delivery with confirmed=true.

REJECTION HANDLING:
- If book_delivery returns "Rejected: ...", tell the user the exact reason and suggest alternatives.
- Never claim success unless book_delivery returned a result starting with "Booked".

OTHER RULES:
- If the user asks what's booked or about appointments, call list_appointments and report the result.
- If the user says "book X for date/time" directly, call book_delivery immediately with confirmed=true — let the tool validate.
- If any tool errors, tell the user it failed. Never claim success.`;

let conversation: any[] = [];

async function loadConversation(): Promise<any[]> {
  try {
    const rs = await db.execute("SELECT role, content FROM sessions ORDER BY id ASC");
    return rs.rows
      .map((r) => ({ role: String(r.role), content: String(r.content) }))
      .filter((m) => m.content && m.content.trim().length > 0);
  } catch (e) {
    console.error("loadConversation failed:", e);
    return [];
  }
}

async function saveMessage(role: string, content: string) {
  try {
    await db.execute({
      sql: "INSERT INTO sessions (role, content) VALUES (?, ?)",
      args: [role, content || ""],
    });
  } catch (e) {
    console.error("saveMessage failed:", e);
  }
}

async function callMcp(name: string, args: any): Promise<{ text: string; structured: any }> {
  const selfUrl = `http://127.0.0.1:${process.env.PORT || 8081}/mcp`;
  const client = new Client({ name: "self", version: "1.0" }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(selfUrl)));
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

  await saveMessage("user", message);
  conversation.push({ role: "user", content: message });

  const trace: any[] = [];
  const cards: any[] = [];

  try {
    for (let turn = 0; turn < 8; turn++) {
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
        await saveMessage("assistant", msg.content || "");
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
    console.error("chat error:", e);
    return res.status(500).json({ error: e.message, trace });
  }
});

app.post("/reset", async (_req, res) => {
  try {
    await db.execute("DELETE FROM sessions");
  } catch (e) {
    console.error("reset failed:", e);
  }
  conversation = [];
  notifiedItems.clear();
  res.json({ ok: true });
});

// ---------- Proactive notifications via SSE ----------
const sseClients: any[] = [];

app.get("/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  sseClients.push(res);
  res.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`);

  req.on("close", () => {
    const idx = sseClients.indexOf(res);
    if (idx >= 0) sseClients.splice(idx, 1);
  });
});

function broadcastSSE(payload: any) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(data);
    } catch (e) {
      // ignore
    }
  }
}

setInterval(() => {
  for (const client of sseClients) {
    try {
      client.write(": ping\n\n");
    } catch (e) {
      // ignore
    }
  }
}, 25000);

const PROACTIVE_INTERVAL_MS = Number(process.env.PROACTIVE_INTERVAL_MS || 30000);

setInterval(async () => {
  if (sseClients.length === 0) return;
  try {
    const rs = await db.execute(
      "SELECT item_name, quantity, threshold FROM inventory WHERE quantity <= threshold"
    );
    for (const row of rs.rows) {
      const name = String(row.item_name);
      if (notifiedItems.has(name)) continue;
      notifiedItems.add(name);

      const message = `Heads up: ${name} is running low (${row.quantity} left). Want me to book a delivery?`;
      const messageHi = `ध्यान दें: ${name} की स्टॉक कम है (${row.quantity} बचे हैं)। क्या मैं डिलीवरी बुक करूँ?`;

      conversation.push({ role: "assistant", content: message });
      await saveMessage("assistant", message);

            broadcastSSE({
        type: "proactive",
        message,
        messageHi,
        card: {
          type: "inventory_alert",
          items: [{ name, quantity: Number(row.quantity), threshold: Number(row.threshold) }],
          hasLowStock: true,
        },
      });
    }
  } catch (e) {
    console.error("proactive check failed:", e);
  }
}, PROACTIVE_INTERVAL_MS);

(async () => {
  conversation = await loadConversation();
  const PORT = process.env.PORT || 8081;
  app.listen(PORT, () => {
    console.log(`MCP + web UI on http://localhost:${PORT}`);
    console.log(`Loaded ${conversation.length} messages from Turso`);
    console.log(`Proactive check every ${PROACTIVE_INTERVAL_MS}ms`);
  });
})();