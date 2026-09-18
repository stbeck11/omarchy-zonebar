// Unit tests for Model.js.
//
// Model.js is a QML .js file, so it has no exports: it declares plain
// functions the way the QML engine expects. The tests load it into a vm
// context and read the functions back out, which keeps the source free of a
// module system it cannot use.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const context = vm.createContext({ Date, Math, parseInt, String, RegExp });
vm.runInContext(fs.readFileSync(path.join(root, "Model.js"), "utf8"), context);
const M = context;

// Arrays created inside the vm belong to its realm, so a strict deep-equal
// against a literal here fails on the prototype even when every element
// matches. Copying into this realm compares the contents, which is the thing
// under test.
const plain = (value) => Array.from(value);

// A fixed instant so every assertion is about the maths, not about today.
// 2026-09-19T03:00:00Z.
const BASE = Date.UTC(2026, 8, 19, 3, 0, 0);

test("zone specs round-trip, deriving labels and dropping duplicates", () => {
  const zones = M.parseZoneSpec("America/Los_Angeles=Pacific,Europe/London, Asia/Kolkata ,Europe/London");
  assert.equal(zones.length, 3, "the repeated zone is dropped");
  assert.deepEqual(plain(zones).map((z) => z.tz), ["America/Los_Angeles", "Europe/London", "Asia/Kolkata"]);
  assert.equal(zones[0].label, "Pacific", "an explicit label is kept");
  assert.equal(zones[1].label, "London", "a missing label is derived from the city");
  assert.equal(zones[2].label, "Kolkata");

  // Only the custom label is written back, so an untouched list stays terse.
  assert.equal(M.serializeZoneSpec(zones), "America/Los_Angeles=Pacific,Europe/London,Asia/Kolkata");
});

test("derived labels drop the region and the underscores", () => {
  assert.equal(M.defaultLabelFor("America/Los_Angeles"), "Los Angeles");
  assert.equal(M.defaultLabelFor("Australia/Hobart"), "Hobart");
  assert.equal(M.defaultLabelFor("UTC"), "UTC");
  assert.equal(M.defaultLabelFor(""), "");
});

test("offsets parse the format date(1) emits, and reject anything else", () => {
  assert.equal(M.parseOffset("+0530"), 330);
  assert.equal(M.parseOffset("-0700"), -420);
  assert.equal(M.parseOffset("+0000"), 0);
  assert.equal(M.parseOffset("+1245"), 765, "Chatham Islands is a real place");
  assert.equal(M.parseOffset("garbage"), null);
  assert.equal(M.parseOffset(""), null);
  assert.equal(M.parseOffset(null), null);
});

test("offset deltas read the way a person says them", () => {
  assert.equal(M.formatOffsetDelta(0), "same");
  assert.equal(M.formatOffsetDelta(180), "+3");
  assert.equal(M.formatOffsetDelta(-300), "-5");
  assert.equal(M.formatOffsetDelta(330), "+5:30");
  assert.equal(M.formatOffsetDelta(-570), "-9:30");
});

test("wall clocks ignore the host's own timezone", () => {
  // 03:00 UTC is 23:00 the previous day in New York (-4 in September).
  const ny = M.wallClock(BASE, -240);
  assert.equal(ny.hour, 23);
  assert.equal(ny.minute, 0);
  assert.equal(ny.day, 18);

  // The same instant is 08:30 in Kolkata, on the next date.
  const kolkata = M.wallClock(BASE, 330);
  assert.equal(kolkata.hour, 8);
  assert.equal(kolkata.minute, 30);
  assert.equal(kolkata.day, 19);
});

test("day deltas show the boundary and nothing else", () => {
  const hobart = M.wallClock(BASE, 600);
  const ny = M.wallClock(BASE, -240);
  const london = M.wallClock(BASE, 60);

  assert.equal(M.dayDelta(hobart, ny), -1, "New York is still on yesterday");
  assert.equal(M.dayDelta(hobart, london), 0, "same calendar day");
  assert.equal(M.dayDeltaLabel(M.dayDelta(hobart, ny)), "-1d");
  assert.equal(M.dayDeltaLabel(0), "", "the usual case prints nothing");
  assert.equal(M.dayDeltaLabel(1), "+1d");
});

test("clocks format in both conventions", () => {
  assert.equal(M.formatClock(15, 5, false), "15:05");
  assert.equal(M.formatClock(15, 5, true), "3:05 pm");
  assert.equal(M.formatClock(0, 0, true), "12:00 am", "midnight is twelve, not zero");
  assert.equal(M.formatClock(12, 0, true), "12:00 pm", "noon is pm");
  assert.equal(M.formatClock(9, 0, false), "09:00");
});

test("phases split the day into something a glance can use", () => {
  assert.equal(M.phaseFor(3), "night");
  assert.equal(M.phaseFor(9), "morning");
  assert.equal(M.phaseFor(14), "afternoon");
  assert.equal(M.phaseFor(20), "evening");
  assert.equal(M.phaseFor(23), "night");
  assert.equal(M.isWorkingHour(9), true);
  assert.equal(M.isWorkingHour(17), true);
  assert.equal(M.isWorkingHour(18), false, "six is the end of the working day");
  assert.equal(M.isWorkingHour(8), false);
});

test("typed times are read forgivingly", () => {
  assert.equal(M.parseTimeInput("3pm"), 15 * 60);
  assert.equal(M.parseTimeInput("3 PM"), 15 * 60);
  assert.equal(M.parseTimeInput("15:00"), 15 * 60);
  assert.equal(M.parseTimeInput("1500"), 15 * 60);
  assert.equal(M.parseTimeInput("3:30pm"), 15 * 60 + 30);
  assert.equal(M.parseTimeInput("09:05"), 9 * 60 + 5);
  assert.equal(M.parseTimeInput("12am"), 0, "twelve am is midnight");
  assert.equal(M.parseTimeInput("12pm"), 12 * 60, "twelve pm is noon");
});

test("nonsense times are rejected rather than guessed at", () => {
  assert.equal(M.parseTimeInput("25:00"), null);
  assert.equal(M.parseTimeInput("10:75"), null);
  assert.equal(M.parseTimeInput("13pm"), null, "no thirteenth hour on a 12-hour clock");
  assert.equal(M.parseTimeInput("lunchtime"), null);
  assert.equal(M.parseTimeInput(""), null);
  assert.equal(M.parseTimeInput(null), null);
});

test("typing a time moves everyone, and picks the nearer of the two answers", () => {
  // 03:00 UTC is 07:00 in Dubai. Asking for 09:00 there is two hours forward.
  assert.equal(M.scrubForTargetTime(BASE, 240, 9 * 60), 120);
  // Asking for 05:00 there is two hours back, not twenty-two forward.
  assert.equal(M.scrubForTargetTime(BASE, 240, 5 * 60), -120);
  // The far side of the clock resolves to whichever direction is shorter.
  const far = M.scrubForTargetTime(BASE, 240, 19 * 60);
  assert.ok(Math.abs(far) <= 720, `wrapped into half a day, got ${far}`);
});

test("buildRows renders the panel, home-relative", () => {
  const zones = M.parseZoneSpec("Australia/Hobart=Home,America/New_York=Eastern,Asia/Kolkata=Mumbai");
  const offsets = { "Australia/Hobart": 600, "America/New_York": -240, "Asia/Kolkata": 330 };
  const rows = M.buildRows(zones, offsets, "Australia/Hobart", BASE, 0, false);

  assert.equal(rows.length, 3);
  assert.equal(rows[0].time, "13:00");
  assert.equal(rows[0].offset, "same", "home has no offset from itself");
  assert.equal(rows[0].isHome, true);
  assert.equal(rows[0].dayLabel, "");

  assert.equal(rows[1].time, "23:00");
  assert.equal(rows[1].offset, "-14", "New York is fourteen hours behind Hobart");
  assert.equal(rows[1].dayLabel, "-1d", "and still on yesterday");
  assert.equal(rows[1].phase, "night");
  assert.equal(rows[1].working, false);

  assert.equal(rows[2].time, "08:30");
  assert.equal(rows[2].offset, "-4:30");
  assert.equal(rows[2].phase, "morning");
});

test("scrubbing moves every row by the same amount", () => {
  const zones = M.parseZoneSpec("Australia/Hobart,America/New_York");
  const offsets = { "Australia/Hobart": 600, "America/New_York": -240 };
  const rows = M.buildRows(zones, offsets, "Australia/Hobart", BASE, 180, false);
  assert.equal(rows[0].time, "16:00", "home moved three hours");
  assert.equal(rows[1].time, "02:00", "so did New York");
  assert.equal(rows[1].dayLabel, "", "and it caught up to the same date");
});

test("a zone whose offset never arrived is shown as unresolved, not as UTC", () => {
  const zones = M.parseZoneSpec("Australia/Hobart,Mars/Olympus_Mons");
  const rows = M.buildRows(zones, { "Australia/Hobart": 600 }, "Australia/Hobart", BASE, 0, false);
  assert.equal(rows[1].resolved, false);
  assert.equal(rows[1].time, "--:--");
  assert.equal(rows[1].offset, "");
});

test("the zone list edits without mutating what it was given", () => {
  const zones = M.parseZoneSpec("Europe/London,Asia/Dubai");
  const frozen = zones.map((z) => z.tz).join(",");

  const added = M.addZone(zones, "Asia/Tokyo");
  assert.equal(added.length, 3);
  assert.equal(added[2].label, "Tokyo");
  assert.equal(M.addZone(added, "Asia/Tokyo").length, 3, "adding a duplicate is a no-op");

  const removed = M.removeZoneAt(added, 0);
  assert.deepEqual(plain(removed).map((z) => z.tz), ["Asia/Dubai", "Asia/Tokyo"]);

  const moved = M.moveZone(added, 2, 0);
  assert.deepEqual(plain(moved).map((z) => z.tz), ["Asia/Tokyo", "Europe/London", "Asia/Dubai"]);

  assert.equal(zones.map((z) => z.tz).join(","), frozen, "the original array is untouched");
});

test("out-of-range edits are clamped rather than throwing", () => {
  const zones = M.parseZoneSpec("Europe/London,Asia/Dubai");
  assert.equal(M.removeZoneAt(zones, 9).length, 2);
  assert.equal(M.removeZoneAt(zones, -1).length, 2);
  assert.deepEqual(plain(M.moveZone(zones, 0, 99)).map((z) => z.tz), ["Asia/Dubai", "Europe/London"]);
  assert.deepEqual(plain(M.moveZone(zones, 1, -5)).map((z) => z.tz), ["Asia/Dubai", "Europe/London"]);
});

test("the shipped defaults parse into six labelled zones", () => {
  const zones = M.parseZoneSpec(M.DEFAULT_ZONE_SPEC);
  assert.equal(zones.length, 6);
  assert.deepEqual(plain(zones).map((z) => z.label),
    ["Pacific", "Eastern", "London", "Dubai", "Mumbai", "Singapore"]);
});

test("slider snapping selects clock quarters, not multiples of fifteen from now", () => {
  const now = BASE + 7 * 60000;
  assert.equal(M.snapScrubInstant(now, 15), BASE + 15 * 60000);
  assert.equal(M.snapScrubInstant(now, -15), BASE - 15 * 60000);
  assert.equal(M.snapScrubInstant(now, 0), BASE);
  assert.equal(M.snapScrubInstant(BASE, 0), BASE);
});

test("quarter-hour snapping includes seconds and rounds halfway forward", () => {
  assert.equal(M.snapScrubInstant(BASE + 7.49 * 60000, 0), BASE);
  assert.equal(M.snapScrubInstant(BASE + 7.5 * 60000, 0), BASE + 15 * 60000);
  assert.equal(M.snapScrubInstant(BASE - 7.5 * 60000, 0), BASE);
  const midnight = Date.UTC(2026, 8, 20);
  assert.equal(M.snapScrubInstant(midnight - 60000, 0), midnight);
});

test("slider endpoints stay within twelve hours and on quarter hours", () => {
  for (const minute of [0, 1, 7, 8, 14, 59]) {
    const now = BASE + minute * 60000 + 30000;
    for (const scrub of [-1000, -720, -719, 0, 719, 720, 1000]) {
      const target = M.snapScrubInstant(now, scrub);
      assert.equal(target % (15 * 60000), 0);
      assert.ok(Math.abs(target - now) <= 720 * 60000);
    }
  }
});

test("snapped instants render quarter hours across fractional zones and date boundaries", () => {
  const zones = M.parseZoneSpec("Australia/Brisbane,America/New_York,Asia/Kolkata,Asia/Kathmandu");
  const offsets = { "Australia/Brisbane": 600, "America/New_York": -240,
    "Asia/Kolkata": 330, "Asia/Kathmandu": 345 };
  const selected = M.snapScrubInstant(BASE + 7 * 60000, 15);
  const rows = M.buildRows(zones, offsets, "Australia/Brisbane", selected, 0, false);
  assert.deepEqual(plain(rows).map(r => r.time), ["13:15", "23:15", "08:45", "09:00"]);
  assert.equal(rows[1].dayLabel, "-1d");
});
