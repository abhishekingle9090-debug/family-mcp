import { describe, it, expect } from "vitest";

// Pure version of the safety rules from book_delivery.
// Mirrors the actual checks in server.ts so tests stay honest.
function validateBooking(params: {
  item: string;
  date: string;
  time: string;
  inventory: string[];
  today: string;
  availability: Array<{ date: string; time: string; is_booked: number }>;
}): string {
  const { item, date, time, inventory, today, availability } = params;

  if (!inventory.map((i) => i.toLowerCase()).includes(item.toLowerCase())) {
    return `Rejected: "${item}" is not in the inventory.`;
  }

  if (date < today) {
    return `Rejected: ${date} is in the past.`;
  }

  const slotExists = availability.some(
    (a) => a.date === date && a.time === time && a.is_booked === 0
  );
  if (!slotExists) {
    return `Rejected: ${date} at ${time} is not available.`;
  }

  return `Booked delivery for ${item} on ${date} at ${time}.`;
}

describe("booking safety layer", () => {
  const inventory = ["Children's Tylenol"];
  const today = "2026-10-21";
  const availability = [
    { date: "2026-10-21", time: "14:00", is_booked: 0 },
    { date: "2026-10-21", time: "16:00", is_booked: 0 },
    { date: "2026-10-22", time: "10:00", is_booked: 0 },
    { date: "2026-10-21", time: "10:00", is_booked: 1 }, // already booked
  ];

  it("rejects an item that is not in inventory", () => {
    const result = validateBooking({
      item: "Aspirin",
      date: "2026-10-22",
      time: "10:00",
      inventory,
      today,
      availability,
    });
    expect(result).toMatch(/Rejected:.*not in the inventory/);
  });

  it("rejects a date in the past", () => {
    const result = validateBooking({
      item: "Children's Tylenol",
      date: "2026-10-20",
      time: "14:00",
      inventory,
      today,
      availability,
    });
    expect(result).toMatch(/Rejected:.*in the past/);
  });

  it("rejects a slot that is already booked", () => {
    const result = validateBooking({
      item: "Children's Tylenol",
      date: "2026-10-21",
      time: "10:00",
      inventory,
      today,
      availability,
    });
    expect(result).toMatch(/Rejected:.*not available/);
  });

  it("accepts a valid booking", () => {
    const result = validateBooking({
      item: "Children's Tylenol",
      date: "2026-10-22",
      time: "10:00",
      inventory,
      today,
      availability,
    });
    expect(result).toMatch(/^Booked delivery/);
  });
});