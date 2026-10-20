# Family Caretaker MCP Agent

Hey — this is my entry for the Alexa+ hackathon. It's a small agent that helps a caregiver keep an eye on supplies and book a delivery when something runs low. The catch is that it never books anything on its own — it always asks first and waits for a clear "yes".

Demo video: PASTE_YOUR_YOUTUBE_LINK_HERE
Friction log: FRICTION_LOG.md

## The idea

Picture a parent at 9pm realizing the kids' Tylenol is basically empty. They don't want to open five apps. They want one thing that already knows the inventory, knows the calendar, and can book a slot — but still asks before doing anything that touches the real world.

So that's what this does:

1. User says "check what's low and book a delivery"
2. Agent calls check_inventory on its own and finds Tylenol at qty 1
3. Then it calls find_available_slots and sees 10:00 / 14:00 / 16:00
4. It replies with a suggestion and asks "shall I book it?"
5. Only after the user says yes does it call book_delivery
6. The booking lands in Turso, so it survives a server restart

## How it's put together

Browser chat UI (public/index.html) sends POST /chat to the Express server (server.ts). Express uses the Groq LLM (openai/gpt-oss-120b) to decide which tool to call. Tool calls go through an MCP client to POST /mcp, which is Streamable HTTP, spec 2025-11-25, stateless mode. The MCP tools read and write to Turso, a cloud SQLite database.

I originally wrote this with the old HTTP+SSE transport and kept getting a 500 on every request. Turns out SSE is deprecated in the current MCP spec, and Alexa+ requires Streamable HTTP specifically. Switched to StreamableHTTPServerTransport in stateless mode (sessionIdGenerator: undefined) and it's been fine since. One POST /mcp endpoint, no sessions, spec-compliant.

## Tools

- check_inventory — returns items where quantity is below the threshold. No confirmation needed.
- find_available_slots — returns mock slots for a given date. No confirmation needed.
- book_delivery — inserts a row into appointments. Requires confirmed=true.
- list_appointments — returns all booked appointments. No confirmation needed.

The confirmation check is inside book_delivery itself, not just in the prompt. If the LLM calls it with confirmed=false, the tool returns "Confirmation required" and writes nothing. Prompts can be ignored; tool logic can't.

## Free stack

- LLM: Groq, openai/gpt-oss-120b — free
- Database: Turso cloud SQLite — free
- MCP SDK: official @modelcontextprotocol/sdk — open source
- UI: vanilla HTML/JS — free
- Hosting: local npx tsx — free

Total: $0. I ran out of AWS credits on Oct 7 so I rebuilt the whole thing on free tiers, and honestly it was fine.

## Running it locally

You need Node 20+, a free Turso account, and a free Groq API key.

First, clone and install:

git clone https://github.com/abhishekingle9090-debug/family-mcp-zero-budget.git
cd family-mcp-zero-budget
npm install

Create a .env file with these three lines:

TURSO_DATABASE_URL=libsql://your-db.turso.io
TURSO_AUTH_TOKEN=your-token
GROQ_API_KEY=gsk_your-key

Then in the Turso SQL editor, run this to create the tables and seed one low-stock item:

CREATE TABLE IF NOT EXISTS inventory (id INTEGER PRIMARY KEY, item_name TEXT, quantity INTEGER, threshold INTEGER);
CREATE TABLE IF NOT EXISTS appointments (id INTEGER PRIMARY KEY, date TEXT, time TEXT, status TEXT);
INSERT INTO inventory (item_name, quantity, threshold) VALUES ('Children''s Tylenol', 1, 3);

Start the server:

npx tsx server.ts

You should see "MCP + web UI on http://localhost:8081". Open that URL in a browser and try "I'm worried about the kids' medicine. Check what's low and book a delivery."

If you want to poke at the MCP server directly, run npx @modelcontextprotocol/inspector, set transport to Streamable HTTP, and set URL to http://localhost:8081/mcp. You should see 4 tools listed.

## Things to try

Proactive flow: ask it to check inventory and book something. It will propose a slot and stop. It will not book until you say yes.

State across restarts: after booking, kill the server with Ctrl+C, start it again, refresh the browser, and ask "what deliveries are booked?". The row is still there because Turso is a real cloud DB, not an in-memory array.

Confirmation gate: if you peek at the trace under each agent reply, book_delivery is only ever called with confirmed=true after you've said yes. Calling it with confirmed=false (or with any other value) just returns a "Confirmation required" message.

## Some things I decided deliberately

Streamable HTTP, stateless mode: the old SSE transport is deprecated and wouldn't pass the Alexa+ spec check. Stateless was simpler too — no session juggling.

Confirmation inside the tool, not the prompt: during testing I had a case where the model said "your delivery is all set" while all three booking calls had actually failed. That was the moment I moved the confirmation check into the tool and added explicit rules to the system prompt about not lying. Both are in the repo now.

Turso instead of local SQLite: a local file is fine for a demo, but judges asking "does it really keep state across sessions?" want to see a real database. Turso is cloud SQLite, so the change is basically just the connection string.

No AWS: everything runs on free Groq + free Turso. Anyone who clones this can actually run it without spending money.

## Known limitations

find_available_slots returns hardcoded times. A real version would plug into Google Calendar or a delivery API.

book_delivery writes to a table but doesn't dispatch a real order. A real version would hit Instacart or similar.

Conversation memory is in-process, so it resets when you restart the server. Database state is the thing that persists — that's the point of the demo.

## License

MIT. See LICENSE.
