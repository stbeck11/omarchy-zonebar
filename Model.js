// Pure timezone math for the Zonebar widget and its panel.
//
// Everything here is Qt-free and side-effect-free so it can be unit tested
// under node (test/model.test.mjs). The QML owns rendering and the shell
// helper owns talking to the system; this file owns the arithmetic, which is
// where the bugs would otherwise hide.
//
// One deliberate choice runs through the whole file: a zone is represented by
// its *current UTC offset in minutes*, never by a name we try to interpret.
// The offsets come from the system's tzdata via bin/zonebar-offsets, so DST,
// half-hour zones and political changes are the operating system's problem
// rather than ours. Minutes east of UTC is the sign convention throughout, so
// Kolkata is +330 and Los Angeles is -420.

var MS_PER_MINUTE = 60000
var MINUTES_PER_DAY = 1440

// The zones a fresh install starts with. Chosen to span the working day
// rather than to be exhaustive: if the defaults already cover your colleagues
// you never have to open the settings at all.
var DEFAULT_ZONE_SPEC = [
  "America/Los_Angeles=Pacific",
  "America/New_York=Eastern",
  "Europe/London=London",
  "Asia/Dubai=Dubai",
  "Asia/Kolkata=Mumbai",
  "Asia/Singapore=Singapore"
].join(",")

// ---- Zone list, stored as one string.
//
// The bar config in shell.json is a flat object of scalars, so the zone list
// travels as a single comma-separated string. Each entry is an IANA name with
// an optional display label after "=", because "Pacific" reads better in a
// narrow panel than "America/Los_Angeles" and only the person reading it can
// say which name they think in.

function parseZoneSpec(spec) {
  var out = []
  var parts = String(spec == null ? "" : spec).split(",")
  for (var i = 0; i < parts.length; i++) {
    var raw = parts[i].trim()
    if (raw === "") continue
    var eq = raw.indexOf("=")
    var tz = (eq === -1 ? raw : raw.slice(0, eq)).trim()
    var label = eq === -1 ? "" : raw.slice(eq + 1).trim()
    if (tz === "") continue
    // A zone listed twice would render twice and reorder unpredictably, so
    // the first mention wins and later ones are dropped.
    if (indexOfZone(out, tz) !== -1) continue
    out.push({ tz: tz, label: label === "" ? defaultLabelFor(tz) : label, custom: label !== "" })
  }
  return out
}

function serializeZoneSpec(zones) {
  var parts = []
  for (var i = 0; i < zones.length; i++) {
    var z = zones[i]
    if (!z || !z.tz) continue
    // Only write the label back when it is not just the derived one, so an
    // untouched list stays short and readable in shell.json.
    parts.push(z.custom && z.label ? z.tz + "=" + z.label : z.tz)
  }
  return parts.join(",")
}

function indexOfZone(zones, tz) {
  for (var i = 0; i < zones.length; i++) if (zones[i] && zones[i].tz === tz) return i
  return -1
}

// "America/Los_Angeles" -> "Los Angeles". The region prefix is noise once the
// city is on screen, and underscores are a filesystem artefact, not a name.
function defaultLabelFor(tz) {
  var name = String(tz == null ? "" : tz)
  var slash = name.lastIndexOf("/")
  if (slash !== -1) name = name.slice(slash + 1)
  return name.replace(/_/g, " ")
}

function addZone(zones, tz, label) {
  if (!tz || indexOfZone(zones, tz) !== -1) return zones.slice()
  var next = zones.slice()
  next.push({ tz: tz, label: label ? label : defaultLabelFor(tz), custom: !!label })
  return next
}

function removeZoneAt(zones, index) {
  if (index < 0 || index >= zones.length) return zones.slice()
  var next = zones.slice()
  next.splice(index, 1)
  return next
}

// Reorder by lifting one entry out and dropping it back in. Returning a new
// array keeps QML's change detection honest; mutating in place would leave
// the repeater showing the old order.
function moveZone(zones, from, to) {
  if (from === to) return zones.slice()
  if (from < 0 || from >= zones.length) return zones.slice()
  var next = zones.slice()
  var item = next.splice(from, 1)[0]
  var target = to < 0 ? 0 : (to > next.length ? next.length : to)
  next.splice(target, 0, item)
  return next
}

// ---- Offsets.

// "+0530" and "-0700" are what `date +%z` emits. Returns minutes east of UTC,
// or null when the text is not an offset, so a failed lookup is visibly
// missing rather than silently treated as UTC.
function parseOffset(text) {
  var m = /^([+-])(\d{2})(\d{2})$/.exec(String(text == null ? "" : text).trim())
  if (!m) return null
  var minutes = parseInt(m[2], 10) * 60 + parseInt(m[3], 10)
  return m[1] === "-" ? -minutes : minutes
}

// The difference between two zones, written the way a person says it: "+3",
// "-5", "+5:30". Zonebar's insight is that the offset you care about is
// relative to *you*, not to UTC, so this is always home-relative.
function formatOffsetDelta(deltaMinutes) {
  if (deltaMinutes === 0) return "same"
  var sign = deltaMinutes < 0 ? "-" : "+"
  var abs = Math.abs(deltaMinutes)
  var hours = Math.floor(abs / 60)
  var mins = abs % 60
  return sign + hours + (mins === 0 ? "" : ":" + pad2(mins))
}

// ---- Wall clocks.

// The wall clock in a zone, for an instant given in UTC milliseconds.
//
// Shifting the instant by the offset and then reading it with the UTC getters
// gives that zone's wall clock without the host's own timezone getting a vote.
// Reading with the local getters would silently add the host offset twice.
function wallClock(baseUtcMs, offsetMinutes) {
  var d = new Date(baseUtcMs + offsetMinutes * MS_PER_MINUTE)
  return {
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    weekday: d.getUTCDay(),
    day: d.getUTCDate(),
    month: d.getUTCMonth(),
    year: d.getUTCFullYear(),
    // Days since the epoch, which is what makes a date comparison between two
    // zones a subtraction rather than a calendar problem.
    epochDay: Math.floor((baseUtcMs + offsetMinutes * MS_PER_MINUTE) / 86400000)
  }
}

// How many calendar days a zone is away from home at this instant. Almost
// always 0, and the whole point of showing it is the moment it is not.
function dayDelta(homeClock, zoneClock) {
  return zoneClock.epochDay - homeClock.epochDay
}

function dayDeltaLabel(delta) {
  if (!delta) return ""
  return (delta > 0 ? "+" : "-") + Math.abs(delta) + "d"
}

// ---- Presentation.

function pad2(n) {
  return (n < 10 ? "0" : "") + n
}

function formatClock(hour, minute, hour12) {
  if (!hour12) return pad2(hour) + ":" + pad2(minute)
  var h = hour % 12
  if (h === 0) h = 12
  return h + ":" + pad2(minute) + (hour < 12 ? " am" : " pm")
}

// A coarse phase for each zone, so a row reads as "the middle of their night"
// at a glance instead of requiring the reader to do the arithmetic. The
// boundaries are deliberately blunt; this is a tint and a word, not a claim
// about anybody's actual schedule.
function phaseFor(hour) {
  if (hour < 6) return "night"
  if (hour < 12) return "morning"
  if (hour < 18) return "afternoon"
  if (hour < 22) return "evening"
  return "night"
}

// Whether a zone is inside conventional working hours. Used only to decide
// whether a row is shown at full strength or dimmed.
function isWorkingHour(hour) {
  return hour >= 9 && hour < 18
}

// Snap the selected instant, rather than the offset from now: at 10:07,
// dragging forward 15 minutes should select 10:15, not 10:22. Keep the
// result on a quarter hour inside the slider's +/-12-hour range. Ties go
// forward. Modern timezone offsets are all multiples of fifteen minutes.
function snapScrubInstant(baseUtcMs, scrubMinutes) {
  var quarter = 15 * MS_PER_MINUTE
  var lower = Math.ceil((baseUtcMs - 720 * MS_PER_MINUTE) / quarter) * quarter
  var upper = Math.floor((baseUtcMs + 720 * MS_PER_MINUTE) / quarter) * quarter
  var target = Math.round((baseUtcMs + scrubMinutes * MS_PER_MINUTE) / quarter) * quarter
  return Math.max(lower, Math.min(upper, target))
}

// ---- Typing a time.
//
// Clicking a time and typing "3pm" is the feature that turns the panel from a
// readout into a calculator, so the parser is forgiving: "3pm", "3 pm",
// "15:00", "1500", "3:30pm" and "09:05" all land.
function parseTimeInput(text) {
  var s = String(text == null ? "" : text).trim().toLowerCase().replace(/\s+/g, "")
  if (s === "") return null

  var meridiem = null
  if (/(am|pm)$/.test(s)) {
    meridiem = s.slice(-2)
    s = s.slice(0, -2)
  }

  var hour = null
  var minute = 0
  var m
  if ((m = /^(\d{1,2}):(\d{2})$/.exec(s))) {
    hour = parseInt(m[1], 10)
    minute = parseInt(m[2], 10)
  } else if ((m = /^(\d{1,2})$/.exec(s))) {
    hour = parseInt(m[1], 10)
  } else if ((m = /^(\d{2})(\d{2})$/.exec(s))) {
    hour = parseInt(m[1], 10)
    minute = parseInt(m[2], 10)
  } else {
    return null
  }

  if (minute > 59) return null
  if (meridiem) {
    if (hour < 1 || hour > 12) return null
    hour = hour % 12
    if (meridiem === "pm") hour += 12
  } else if (hour > 23) return null

  return hour * 60 + minute
}

// The instant at which a chosen wall-clock time happens in a given zone,
// expressed as an offset in minutes from "now". Typing 3pm against Dubai has
// to move every other row too, and this is the number that moves them.
//
// The result is wrapped into +/- 12 hours: asking for 3pm when it is already
// 4pm there means this afternoon just gone, not this time tomorrow.
function scrubForTargetTime(baseUtcMs, offsetMinutes, targetMinuteOfDay) {
  var now = wallClock(baseUtcMs, offsetMinutes)
  var current = now.hour * 60 + now.minute
  var delta = targetMinuteOfDay - current
  while (delta > MINUTES_PER_DAY / 2) delta -= MINUTES_PER_DAY
  while (delta < -MINUTES_PER_DAY / 2) delta += MINUTES_PER_DAY
  return delta
}

// ---- The whole panel in one call.
//
// Given the zone list, the offsets the helper reported, the home zone and the
// current scrub, produce exactly what the panel renders. Keeping this as one
// pure function is what makes the panel's own code a layout exercise.
function buildRows(zones, offsets, homeTz, baseUtcMs, scrubMinutes, hour12) {
  var instant = baseUtcMs + (scrubMinutes || 0) * MS_PER_MINUTE
  var homeOffset = offsets && offsets[homeTz] != null ? offsets[homeTz] : 0
  var home = wallClock(instant, homeOffset)
  var rows = []

  for (var i = 0; i < zones.length; i++) {
    var z = zones[i]
    var off = offsets ? offsets[z.tz] : null
    if (off == null) {
      // A zone whose offset never arrived is shown as unresolved rather than
      // quietly rendered at UTC, which would be a wrong time presented with
      // total confidence.
      rows.push({ tz: z.tz, label: z.label, resolved: false, time: "--:--",
                  offset: "", dayLabel: "", phase: "night", working: false, isHome: z.tz === homeTz })
      continue
    }
    var clock = wallClock(instant, off)
    rows.push({
      tz: z.tz,
      label: z.label,
      resolved: true,
      time: formatClock(clock.hour, clock.minute, hour12),
      hour: clock.hour,
      minute: clock.minute,
      offset: formatOffsetDelta(off - homeOffset),
      offsetMinutes: off,
      dayLabel: dayDeltaLabel(dayDelta(home, clock)),
      phase: phaseFor(clock.hour),
      working: isWorkingHour(clock.hour),
      isHome: z.tz === homeTz
    })
  }
  return rows
}
