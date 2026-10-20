import "dotenv/config";
import OpenAI from "openai";

const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY!,
  baseURL: "https://api.groq.com/openai/v1",
});

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: any[];
};

// Groq tool definitions mirror your MCP tools so the model knows what it can call
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
        "Book a delivery slot. NEVER call unless the user has explicitly confirmed with 'yes'.",
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

const SYSTEM_PROMPT = `You are a proactive family caretaker assistant.
Follow this exact flow when the user asks for help:
1. Call check_inventory to see what's low.
2. If something is low, call find_available_slots for a near-future date.
3. Suggest the best slot to the user in natural language and ASK for confirmation.
4. Only if the user has said "yes" (in this or a previous message), call book_delivery with confirmed=true.
Never call book_delivery with confirmed=true unless the user has explicitly said yes.
Keep replies short and warm.`;

export async function planStep(messages: ChatMessage[]) {
  const response = await groq.chat.completions.create({
    model: "openai/gpt-oss-120b",
    messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
    tools,
    tool_choice: "auto",
    temperature: 0.3,
  });

  return response.choices[0].message;
}