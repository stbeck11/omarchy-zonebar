import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model

// Zonebar's presence in the bar, and the host for the panel.
//
// The bar half is deliberately quiet. Omarchy already has a clock, so a second
// widget shouting a second time at you is noise; by default this is one glyph
// that means "the rest of the world is behind here". The panel is where the
// answer lives, and a left click is the whole interaction.
//
// Offsets are resolved here rather than in the panel because the bar label may
// need one too, and because a single owner of the lookup means one timer and
// one source of truth rather than two that can disagree by a minute.
BarWidget {
  id: root
  moduleName: "stbeck11.zonebar"

  readonly property string zoneSpec: setting("zones", Model.DEFAULT_ZONE_SPEC)
  readonly property string configuredHome: String(setting("homeZone", "") || "").trim()
  readonly property bool hour12: setting("hour12", false) === true
  readonly property bool snapToQuarterHour: setting("snapToQuarterHour", false) === true
  readonly property string barDisplay: setting("barDisplay", "Icon")
  readonly property string configuredBarZone: String(setting("barZone", "") || "").trim()

  readonly property var zones: Model.parseZoneSpec(zoneSpec)

  // The zone every offset is measured from. The configured value wins so a
  // traveller can keep thinking in the timezone they left; otherwise it is
  // whatever this machine believes, which is the answer for everyone else.
  readonly property string homeZone: configuredHome !== "" ? configuredHome : systemZone
  property string systemZone: "UTC"

  // tz -> minutes east of UTC, filled in by the helper. A zone missing from
  // here is unresolved, and the panel says so rather than guessing.
  property var offsets: ({})

  property date now: new Date()
  property int freeScrubMinutes: 0
  // A snapped selection is an instant: minute ticks must not drift it off
  // the quarter hour. Null means the original, relative scrub is in use.
  property var snappedUtcMs: null
  readonly property bool scrubbed: snappedUtcMs !== null || freeScrubMinutes !== 0
  readonly property int scrubMinutes: snappedUtcMs !== null
    ? Math.round((snappedUtcMs - now.getTime()) / Model.MS_PER_MINUTE) : freeScrubMinutes
  readonly property real displayUtcMs: snappedUtcMs !== null
    ? snappedUtcMs : now.getTime() + freeScrubMinutes * Model.MS_PER_MINUTE

  readonly property var barRow: rowFor(configuredBarZone !== "" ? configuredBarZone
                                                                : (zones.length > 0 ? zones[0].tz : homeZone))
  readonly property bool showsIcon: barDisplay !== "Time"
  readonly property bool showsTime: barDisplay !== "Icon"
  readonly property string barTime: barRow && barRow.resolved ? barRow.time : ""
  readonly property string barText: showsTime && barTime !== "" ? barTime : ""

  function rowFor(tz) {
    var rows = Model.buildRows(zones, offsets, homeZone, displayUtcMs, 0, hour12)
    for (var i = 0; i < rows.length; i++) if (rows[i].tz === tz) return rows[i]
    // A bar zone that is not in the list is still worth answering, so it is
    // resolved on its own rather than silently falling back to the first row.
    if (offsets[tz] != null) {
      var single = Model.buildRows([{ tz: tz, label: Model.defaultLabelFor(tz) }],
                                   offsets, homeZone, displayUtcMs, 0, hour12)
      return single[0]
    }
    return null
  }

  function rows() {
    return Model.buildRows(zones, offsets, homeZone, displayUtcMs, 0, hour12)
  }

  // ---- Config writes.
  //
  // Editing the list from inside the panel has to survive a restart, so it
  // goes back to shell.json the same way the first-party clock persists a
  // cycled format: applied locally first so the panel updates on the click,
  // then handed to the shell, which returns it as the same value.
  function persistZones(nextZones) {
    var entry = { id: root.moduleName }
    for (var key in root.settings) if (key !== "id") entry[key] = root.settings[key]
    entry.zones = Model.serializeZoneSpec(nextZones)
    root.settings = entry
    if (root.bar && root.bar.shell && typeof root.bar.shell.updateEntryInline === "function")
      root.bar.shell.updateEntryInline(root.moduleName, entry)
    refreshOffsets()
  }

  function refresh() {
    now = new Date()
    refreshOffsets()
  }

  function refreshOffsets() {
    var wanted = []
    for (var i = 0; i < zones.length; i++) wanted.push(zones[i].tz)
    if (homeZone !== "" && wanted.indexOf(homeZone) === -1) wanted.push(homeZone)
    if (configuredBarZone !== "" && wanted.indexOf(configuredBarZone) === -1) wanted.push(configuredBarZone)
    if (wanted.length === 0) return
    offsetProc.command = [Qt.resolvedUrl("bin/zonebar-offsets").toString().replace("file://", "")].concat(wanted)
    offsetProc.running = true
  }

  function setScrub(minutes, snap) {
    freeScrubMinutes = Math.max(-720, Math.min(720, Math.round(minutes)))
    snappedUtcMs = snap ? Model.snapScrubInstant(now.getTime(), minutes) : null
  }

  function resetScrub() {
    snappedUtcMs = null
    freeScrubMinutes = 0
  }

  // ---- Panel plumbing. Bar.findPanelWidget requires open/close/opened on the
  //      bar-widget root, so the widget stands in as the panel's identity.
  readonly property bool opened: panelLoader.item ? panelLoader.item.opened === true : false

  function open() { if (panelLoader.item) panelLoader.item.openFromHotkey() }
  function close() { if (panelLoader.item) panelLoader.item.close() }
  function togglePanel() { if (panelLoader.item) panelLoader.item.toggle() }

  readonly property bool popoutSwitchClosing: panelLoader.item ? panelLoader.item.popoutSwitchClosing === true : false
  function closeForPopoutSwitch() { if (panelLoader.item) panelLoader.item.closeForPopoutSwitch() }

  readonly property real openPanelIndicatorWidth: button.labelWidth
  readonly property real openPanelIndicatorHeight: Math.max(Style.space(10), Math.round(Style.bar.iconSlot * 0.55))

  function injectPanel() {
    var target = panelLoader.item
    if (!target) return
    if ("bar" in target) target.bar = root.bar
    if ("settings" in target) target.settings = root.settings
    if ("anchorItem" in target) target.anchorItem = button
    if ("hostWidget" in target) target.hostWidget = root
  }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  onBarChanged: injectPanel()
  onSettingsChanged: { injectPanel(); refreshOffsets() }
  Component.onCompleted: { systemZoneProc.running = true; refreshOffsets() }

  // Minute precision, because that is the smallest unit anything here shows.
  SystemClock {
    id: clock
    precision: SystemClock.Minutes
    onDateChanged: root.now = date
  }

  // Offsets change only at daylight-saving boundaries, which always land on a
  // minute boundary, but re-asking every minute would be a process per minute
  // forever. Hourly is often enough to catch a transition within the hour, and
  // opening the panel re-asks anyway, so the visible answer is fresh whenever
  // anybody is actually looking at it.
  Timer {
    interval: 3600000
    running: true
    repeat: true
    onTriggered: root.refreshOffsets()
  }

  Process {
    id: offsetProc
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var next = {}
        var lines = String(text || "").split("\n")
        for (var i = 0; i < lines.length; i++) {
          var parts = lines[i].split("\t")
          if (parts.length !== 2) continue
          var minutes = Model.parseOffset(parts[1])
          if (minutes !== null) next[parts[0]] = minutes
        }
        root.offsets = next
      }
    }
  }

  // The machine's own zone, so "home" needs no configuration in the common
  // case. timedatectl is asked rather than $TZ because $TZ is usually unset.
  Process {
    id: systemZoneProc
    command: ["sh", "-c", "timedatectl show -p Timezone --value 2>/dev/null || readlink -f /etc/localtime | sed 's|.*/zoneinfo/||'"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var value = String(text || "").trim()
        if (value !== "") root.systemZone = value
        root.refreshOffsets()
      }
    }
  }

  Loader {
    id: panelLoader
    active: true
    source: Qt.resolvedUrl("Panel.qml")
    visible: false
    onLoaded: {
      root.injectPanel()
      Qt.callLater(root.injectPanel)
    }
  }


  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    // The glyph is a globe with meridians: the widget is about elsewhere, and
    // a second clock face next to Omarchy's own clock would read as a bug.
    text: root.showsIcon ? (root.barText !== "" ? "󰖟  " + root.barText : "󰖟") : root.barText
    labelVisible: true
    hasVisualContent: text !== ""
    horizontalMargin: 8.75
    verticalPadding: 8.75

    onPressed: function(b) {
      // Right click drops any scrub and returns the panel to now, which is the
      // thing you want most often after playing with the slider.
      if (b === Qt.RightButton) { root.resetScrub(); root.refresh() }
      else root.togglePanel()
    }
  }
}
