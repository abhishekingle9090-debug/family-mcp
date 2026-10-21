# Family Caretaker MCP Agent

A small agent that helps a caregiver keep an eye on household supplies and book a delivery when something runs low. The agent always asks for explicit confirmation before it books anything.

- Live demo: https://family-mcp.onrender.com
- Friction log: [FRICTION_LOG.md](./FRICTION_LOG.md)
- License: MIT

The live demo runs on Render's free tier, so the first request after a period of inactivity can take around 30 seconds to wake the instance up.

## The problem

A parent at 9pm realizes the kids' medicine is basically empty. They don't want to open five apps to check stock, look at availability, and place an order. They want one assistant that already knows the inventory, knows the calendar, and can book a slot — but still asks before it does anything that touches the real world.

That's the whole point of this project. Proactive when it needs to be, and gated when it matters.

## What it does

1. User says something like "check what's low and book a delivery", or just says "hi" and the agent decides to look on its own.
2. Agent calls `check_inventory` and finds Children's Tylenol at quantity 1 (threshold is 3).
3. Agent calls `find_available_slots` and reads the current availability from Turso.
4. Agent replies with a suggestion and asks "shall I book it?".
5. Only after the user says yes does it call `book_delivery` with `confirmed=true`.
6. The booking is written to Turso and the slot is marked as taken in the availability table.
7. On the next request, the booked slot no longer appears in the list.

The whole conversation is also persisted in Turso, so restarting the server doesn't wipe the chat history.

## Architecture

```
Browser chat UI (public/index.html)
        |
        | POST /chat
        v
Express server (server.ts)
        |
        +--> Groq LLM (openai/gpt-oss-120b) decides which tool to call
        |
        +--> MCP client --> POST /mcp
                            (Streamable HTTP, spec 2025-11-25, stateless)
                            |
                            v
                         MCP tools
                            |
                            v
                         Turso (cloud SQLite)
                            - inventory
                            - appointments
                            - availability
                            - sessions
```

One thing that cost me a few hours: I originally built this with the old HTTP+SSE transport and got a 500 on every request. SSE is deprecated in the current MCP spec, and Alexa+ requires Streamable HTTP specifically. Switched to `StreamableHTTPServerTransport` in stateless mode (`sessionIdGenerator: undefined`) and it's worked since. One `POST /mcp` endpoint, no sessions, spec-compliant.

## Tools

- `check_inventory` — returns items where `quantity <= threshold`. No confirmation needed.
- `find_available_slots` — returns slots for a date that exist in the `availability` table and are not marked as booked. No confirmation needed.
- `book_delivery` — inserts a row into `appointments` and marks the slot as booked in `availability`. Requires `confirmed=true`.
- `list_appointments` — returns all future bookings. No confirmation needed.

Two layers of safety guard the booking flow:

- The system prompt tells the model not to claim success unless `book_delivery` actually returned a "Booked..." message. I added this after a test where the model said "your delivery is all set" while all three booking calls had actually failed.
- The tool itself validates everything before writing: item must exist in inventory, date must not be in the past, time must be a valid slot, and the slot must not already be booked for that date. If any check fails, the tool returns a message starting with "Rejected:" and writes nothing. The model can't override this — it's hardcoded.

## Stack

- LLM: Groq, `openai/gpt-oss-120b` — free tier
- Database: Turso (cloud SQLite) — free tier
- MCP SDK: official `@modelcontextprotocol/sdk`
- UI: plain HTML/JS with the Web Speech API for voice input
- Hosting: Render free tier (may sleep after 15 minutes of inactivity)
- Local dev: `npx tsx server.ts`

Total runtime cost: $0. I ran out of AWS credits on Oct 7, so I rebuilt the whole thing on free tiers.

## Run locally

Requirements: Node 20+, a free Turso account, and a free Groq API key.

Clone and install:

```
git clone https://github.com/abhishekingle9090-debug/family-mcp-zero-budget.git
cd family-mcp-zero-budget
npm install
```

Create a `.env` file with these three lines:

```
TURSO_DATABASE_URL=libsql://your-db.turso.io
TURSO_AUTH_TOKEN=your-token
GROQ_API_KEY=gsk_your-key
```

In the Turso SQL editor, create the tables and seed one low-stock item:

```sql
CREATE TABLE IF NOT EXISTS inventory (
  id INTEGER PRIMARY KEY,
  item_name TEXT,
  quantity INTEGER,
  threshold INTEGER
);

CREATE TABLE IF NOT EXISTS appointments (
  id INTEGER PRIMARY KEY,
  date TEXT,
  time TEXT,
  status TEXT
);

CREATE TABLE IF NOT EXISTS availability (
  id INTEGER PRIMARY KEY,
  date TEXT,
  time TEXT,
  is_booked INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY,
  role TEXT,
  content TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO inventory (item_name, quantity, threshold)
VALUES ('Children''s Tylenol', 1, 3);

INSERT INTO availability (date, time) VALUES
  ('2026-10-21', '10:00'),
  ('2026-10-21', '14:00'),
  ('2026-10-21', '16:00'),
  ('2026-10-22', '10:00'),
  ('2026-10-22', '14:00'),
  ('2026-10-22', '16:00');
```

Start the server:

```
npx tsx server.ts
```

You should see:

```
MCP + web UI on http://localhost:8081
Loaded X messages from Turso
```

Open http://localhost:8081 and try "hi" or "I'm worried about the kids' medicine. Check what's low and book a delivery." The mic button uses the Web Speech API (Chrome and Edge only) if you want to try voice input.

To test the MCP server directly:

```
npx @modelcontextprotocol/inspector
```

Set transport to Streamable HTTP and URL to `http://localhost:8081/mcp`. You should see 4 tools listed.

## What to try

**Proactive flow.** Say "hi". The agent doesn't just greet back — it calls `check_inventory`, sees Tylenol is low, calls `find_available_slots`, and proposes a slot. It won't book until you say yes.

**State across restarts.** Book something, kill the server with Ctrl+C, start it again, refresh the browser, and ask "what deliveries are booked?". The row is still there because Turso is a real database, not an in-memory array. The conversation history is also preserved.

**Slot filtering.** Book the 10:00 slot, then say "hi" again. The 10:00 slot is gone from the list because `book_delivery` marked it as booked in the `availability` table. No hardcoded array decides what's available — it's a live query.

**Safety layer.** Try to book something that isn't in inventory (e.g. "book aspirin for tomorrow at 14:00"). The tool rejects it with `Rejected: "Aspirin" is not in the inventory`. The LLM calls the tool and the tool refuses to write. Same for past dates and already-booked slots.

## Some decisions worth calling out

**Streamable HTTP, stateless mode.** Deprecated SSE wouldn't pass the Alexa+ spec check. Stateless was simpler too — no session juggling.

**Confirmation and validation inside the tool, not the prompt.** Prompts can be ignored by the model. Hardcoded checks can't. The `book_delivery` tool runs every rule before it writes anything.

**Turso instead of a local SQLite file.** A local file works for a demo, but "does it really keep state across sessions" is a question judges actually ask. Turso is cloud SQLite, so switching over is basically just the connection string. Conversation history also lives there.

**No AWS.** Everything runs on free Groq + free Turso. Anyone who clones the repo can run it without spending money.

## Known limitations

- `book_delivery` writes to a table but doesn't dispatch a real order. A production version would hit a grocery or pharmacy API.
- `find_available_slots` reads from a seeded `availability` table, not from a real calendar. Wiring up Google Calendar is the obvious next step.
- The Render free tier sleeps after inactivity. The first request after a nap takes around 30 seconds.
- Voice input only works in browsers that support the Web Speech API (Chrome, Edge). Firefox users get text-only.

## License

MIT. See [LICENSE](./LICENSE).
