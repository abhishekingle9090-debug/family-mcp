import "dotenv/config";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import OpenAI from "openai";
import * as readline from "readline";

const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY!,
  baseURL: "https://api.groq.com/openai/v1",
});

const tools = [
  {
    type: "function" as const,
    function: {
      name: "check_inventory",
      description: "Check inventory for items below their low-stock threshold.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "find_available_slots",
      description: "Find available appointment slots on a given date.",
      parameters: {
        type: "object",
        properties: { date: { type: "string", description: "YYYY-MM-DD" } },
        required: ["date"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "book_delivery",
      description:
        "Book a delivery slot. NEVER call with confirmed=true unless the user has explicitly said yes to the specific item/date/time.",
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
];

const today = new Date().toISOString().split("T")[0];

const SYSTEM_PROMPT = `Current date: ${today}.
You are a proactive family caretaker assistant.

Follow this exact flow:
1. When the user asks for help, call check_inventory.
2. If items are low, call find_available_slots for tomorrow's date.
3. Reply in natural language: name the low item, propose one slot, and ASK "Shall I book it?".
4. WAIT for the user's explicit yes.
5. Only after the user says yes, c
all book_delivery with confirmed=true.

Rules:
- Never call book_delivery with confirmed=true without explicit user confirmation.
- Keep replies short and warm.
- If any tool returns an error or "not found", DO NOT claim success. Tell the user the action failed and what went wrong.
- Only say a booking is "done" or "confirmed" if the book_delivery tool returned a result starting with "Booked".
- If a tool returns "All items are sufficiently stocked", just say so and offer alternatives.`;

async function main() {
  // 1. Connect to your MCP server
  const transport = new StreamableHTTPClientTransport(
    new URL("http://localhost:8081/mcp")
  );
  const client = new Client(
    { name: "family-agent", version: "1.0.0" },
    { capabilities: {} }
  );
  await client.connect(transport);
  console.log("✓ Connected to MCP server at http://localhost:8081/mcp");

  // 2. Conversation history (persists for the whole session)
  const messages: any[] = [{ role: "system", content: SYSTEM_PROMPT }];

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const ask = (q: string) =>
    new Promise<string>((resolve) => rl.question(q, resolve));

  console.log("Type your request (or 'quit' to exit).\n");

  while (true) {
    const input = (await ask("You: ")).trim();
    if (!input || input.toLowerCase() === "quit") break;

    messages.push({ role: "user", content: input });

    // 3. Agent loop — let the model call tools until it produces text
    for (let turn = 0; turn < 6; turn++) {
      const response = await groq.chat.completions.create({
        model: "openai/gpt-oss-120b",
        messages,
        tools,
        tool_choice: "auto",
        temperature: 0.3,
      });

      const msg = response.choices[0].message;
      messages.push(msg);

      // No tool calls → final answer
      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        console.log(`Agent: ${msg.content}\n`);
        break;
      }

      // Execute each tool call against the MCP server
      for (const call of msg.tool_calls) {
        const args = JSON.parse(call.function.arguments || "{}");
        console.log(
          `  [tool] ${call.function.name}(${JSON.stringify(args)})`
        );

        const result = await client.callTool({
          name: call.function.name,
          arguments: args,
        });

        const text = (result.content as any[])
          .map((c) => c.text || "")
          .join("\n");
        console.log(`  [result] ${text}`);

        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: text,
        });
      }
    }
  }

  await client.close();
  rl.close();
  console.log("Bye.");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});