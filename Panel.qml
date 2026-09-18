import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model

// The panel: every zone at once, measured from wherever you are.
//
// The layout answers three questions in the order people ask them. What time
// is it there (the time, set large). How far is that from me (the offset,
// beside it, relative rather than absolute because "+3" is what you say out
// loud and "UTC+4" is not). Is that a reasonable hour (the phase word and the
// dimming, so a row reads as "the middle of their night" without arithmetic).
//
// The slider underneath is the part that turns a readout into a tool: drag it
// and every row moves together, so finding an hour that works for five cities
// is a drag rather than five sums. Clicking a time and typing one does the
// same thing from the other end.
Panel {
  id: root
  moduleName: "stbeck11.zonebar"
  ipcTarget: ""
  manageIpc: false

  property var anchorItem: null
  property var hostWidget: null
  readonly property var barIdentity: hostWidget || root

  // Everything displayed comes from the widget, which owns the offsets and the
  // clock. The panel holds no duplicate state beyond what it is editing.
  readonly property var rows: hostWidget ? hostWidget.rows() : []
  readonly property string homeZone: hostWidget ? hostWidget.homeZone : "UTC"
  readonly property bool hour12: hostWidget ? hostWidget.hour12 : false
  readonly property int scrubMinutes: hostWidget ? hostWidget.scrubMinutes : 0
  readonly property bool scrubbed: hostWidget ? hostWidget.scrubbed : false

  property int editingIndex: -1
  property bool addingZone: false
  property var availableZones: []

  function open() {
    root.controller.show()
    if (hostWidget) hostWidget.refresh()
  }

  function openFromHotkey() {
    root.controller.show()
    if (hostWidget) hostWidget.refresh()
  }

  function close() {
    cancelEditing()
    addingZone = false
    root.controller.hide()
  }

  function toggle() {
    if (root.opened) root.close()
    else root.openFromHotkey()
  }

  function switchPanel(direction) {
    if (root.bar && typeof root.bar.switchPanelFrom === "function")
      return root.bar.switchPanelFrom(root.barIdentity, direction)
    return false
  }

  // ---- Scrubbing.

  function setScrub(minutes, snap) {
    if (!hostWidget) return
    hostWidget.setScrub(minutes, snap === true)
  }

  function resetScrub() {
    if (hostWidget) hostWidget.resetScrub()
  }

  // Typing a time against one row moves every row, because the question being
  // asked is "when it is 3pm there, what is it everywhere else".
  function applyTypedTime(index, text) {
    if (!hostWidget || index < 0 || index >= rows.length) return false
    var row = rows[index]
    if (!row.resolved) return false
    var minuteOfDay = Model.parseTimeInput(text)
    if (minuteOfDay === null) return false
    var base = hostWidget.now.getTime()
    setScrub(Model.scrubForTargetTime(base, row.offsetMinutes, minuteOfDay))
    return true
  }

  function cancelEditing() {
    editingIndex = -1
  }

  // ---- Editing the list.

  function removeAt(index) {
    if (!hostWidget) return
    hostWidget.persistZones(Model.removeZoneAt(hostWidget.zones, index))
  }

  function moveRow(from, to) {
    if (!hostWidget) return
    if (to < 0 || to >= rows.length) return
    hostWidget.persistZones(Model.moveZone(hostWidget.zones, from, to))
  }

  function addZone(tz) {
    if (!hostWidget || !tz) return
    hostWidget.persistZones(Model.addZone(hostWidget.zones, tz))
    addingZone = false
  }

  function loadZoneList() {
    if (availableZones.length > 0) return
    zoneListProc.command = [Qt.resolvedUrl("bin/zonebar-offsets").toString().replace("file://", ""), "--list"]
    zoneListProc.running = true
  }

  Process {
    id: zoneListProc
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var out = []
        var lines = String(text || "").split("\n")
        for (var i = 0; i < lines.length; i++) {
          var name = lines[i].trim()
          if (name !== "") out.push(name)
        }
        root.availableZones = out
      }
    }
  }

  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.barIdentity
    bar: root.bar
    open: root.opened
    centerOnBar: true
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(360))
    contentHeight: panel.fittedContentHeight(content.implicitHeight)

  PanelKeyCatcher {
    id: keyCatcher
    anchors.fill: parent
    blocked: root.editingIndex !== -1 || root.addingZone
    onCloseRequested: root.close()
    onTabRequested: function(direction) { root.switchPanel(direction) }

    Flickable {
      id: scroll
      anchors.fill: parent
      contentWidth: width
      contentHeight: content.implicitHeight
      clip: true
      boundsBehavior: Flickable.StopAtBounds
      interactive: contentHeight > height

      Column {
        id: content
        width: scroll.width
        spacing: Style.space(10)

        // ---- Header: where "now" actually is, and a way back to it.
        Item {
          width: parent.width
          height: headerRow.implicitHeight + Style.space(8)

          Row {
            id: headerRow
            anchors.left: parent.left
            anchors.right: parent.right
            anchors.leftMargin: Style.space(16)
            anchors.rightMargin: Style.space(16)
            anchors.verticalCenter: parent.verticalCenter
            spacing: Style.space(10)

            Text {
              textFormat: Text.PlainText
              anchors.verticalCenter: parent.verticalCenter
              text: Model.defaultLabelFor(root.homeZone)
              color: root.bar ? root.bar.foreground : Color.foreground
              font.family: root.bar ? root.bar.fontFamily : undefined
              font.pixelSize: Style.font.subtitle
              font.bold: true
            }

            Text {
              textFormat: Text.PlainText
              anchors.verticalCenter: parent.verticalCenter
              // Saying "now" plainly is worth a word, because the whole panel
              // lies convincingly while the slider is off zero.
              text: root.scrubbed ? Model.formatOffsetDelta(root.scrubMinutes) + " from now" : "now"
              color: root.bar ? root.bar.foreground : Color.foreground
              opacity: root.scrubbed ? 1.0 : 0.6
              font.family: root.bar ? root.bar.fontFamily : undefined
              font.pixelSize: Style.font.body
            }

            Item { width: 1; height: 1 }
          }
        }

        // ---- One row per zone.
        Repeater {
          model: root.rows

          Item {
            id: zoneRow
            required property var modelData
            required property int index
            width: content.width
            height: Style.space(40)

            // The whole row is the click target for typing a time: a small
            // target on the time text alone would be fiddly, and there is
            // nothing else on the row that wants a click.
            MouseArea {
              anchors.fill: parent
              acceptedButtons: Qt.LeftButton | Qt.MiddleButton
              onClicked: function(mouse) {
                if (mouse.button === Qt.MiddleButton) root.removeAt(zoneRow.index)
                else if (zoneRow.modelData.resolved) {
                  root.editingIndex = zoneRow.index
                  timeInput.text = ""
                  timeInput.forceActiveFocus()
                }
              }
            }

            Row {
              anchors.fill: parent
              anchors.leftMargin: Style.space(16)
              anchors.rightMargin: Style.space(16)
              spacing: Style.space(10)

              // Label, and the phase underneath it. Dimmed outside working
              // hours so the rows you should not be ringing recede.
              Column {
                anchors.verticalCenter: parent.verticalCenter
                width: Math.round(zoneRow.width * 0.34)
                spacing: 0

                Text {
                  textFormat: Text.PlainText
                  text: zoneRow.modelData.label
                  elide: Text.ElideRight
                  width: parent.width
                  color: root.bar ? root.bar.foreground : Color.foreground
                  opacity: zoneRow.modelData.working ? 1.0 : 0.75
                  font.family: root.bar ? root.bar.fontFamily : undefined
                  font.pixelSize: Style.font.body
                  font.bold: zoneRow.modelData.isHome
                }

                Text {
                  textFormat: Text.PlainText
                  text: zoneRow.modelData.resolved ? zoneRow.modelData.phase : "unknown zone"
                  color: root.bar ? root.bar.foreground : Color.foreground
                  opacity: 0.45
                  font.family: root.bar ? root.bar.fontFamily : undefined
                  font.pixelSize: Style.font.bodySmall
                }
              }

              // The time, set large because it is the answer.
              Text {
                anchors.verticalCenter: parent.verticalCenter
                textFormat: Text.PlainText
                visible: root.editingIndex !== zoneRow.index
                text: zoneRow.modelData.time
                color: root.bar ? root.bar.foreground : Color.foreground
                opacity: zoneRow.modelData.resolved ? (zoneRow.modelData.working ? 1.0 : 0.8) : 0.4
                font.family: root.bar ? root.bar.fontFamily : undefined
                font.pixelSize: Style.font.heading
              }

              TextField {
                id: timeInput
                anchors.verticalCenter: parent.verticalCenter
                visible: root.editingIndex === zoneRow.index
                width: Style.space(90)
                placeholderText: "3pm"
                onAccepted: {
                  if (root.applyTypedTime(zoneRow.index, text)) root.cancelEditing()
                  else text = ""
                }
                Keys.onEscapePressed: root.cancelEditing()
              }

              // The day boundary, which is the thing people get wrong.
              Text {
                anchors.verticalCenter: parent.verticalCenter
                textFormat: Text.PlainText
                visible: zoneRow.modelData.dayLabel !== ""
                text: zoneRow.modelData.dayLabel
                color: root.bar ? root.bar.foreground : Color.foreground
                opacity: 0.7
                font.family: root.bar ? root.bar.fontFamily : undefined
                font.pixelSize: Style.font.bodySmall
                font.bold: true
              }
            }

            // The offset, pinned right so the column reads as a column.
            Text {
              anchors.right: parent.right
              anchors.rightMargin: Style.space(16)
              anchors.verticalCenter: parent.verticalCenter
              textFormat: Text.PlainText
              text: zoneRow.modelData.offset
              color: root.bar ? root.bar.foreground : Color.foreground
              opacity: zoneRow.modelData.isHome ? 0.45 : 0.75
              font.family: root.bar ? root.bar.fontFamily : undefined
              font.pixelSize: Style.font.body
            }
          }
        }

        PanelSeparator { width: parent.width }

        // ---- The slider. Twelve hours either way covers every pair of zones
        //      on Earth, so there is never a reason to want more range.
        Item {
          width: parent.width
          height: Style.space(44)

          PanelSlider {
            anchors.left: parent.left
            anchors.right: parent.right
            anchors.leftMargin: Style.space(16)
            anchors.rightMargin: Style.space(16)
            anchors.verticalCenter: parent.verticalCenter
            bar: root.bar
            minimum: -720
            maximum: 720
            step: 15
            integer: true
            value: Math.max(-720, Math.min(720, root.scrubMinutes))
            onMoved: function(value) { root.setScrub(value, root.hostWidget && root.hostWidget.snapToQuarterHour) }
            // Right-clicking the track is the fastest way back to now, and
            // costs nothing to offer since the slider already reports it.
            onRightClicked: root.resetScrub()
          }
        }

        // ---- Actions.
        Item {
          width: parent.width
          height: actions.implicitHeight + Style.space(10)

          Row {
            id: actions
            anchors.left: parent.left
            anchors.leftMargin: Style.space(16)
            anchors.verticalCenter: parent.verticalCenter
            spacing: Style.space(8)

            Button {
              foreground: root.bar ? root.bar.foreground : Color.foreground
              fontFamily: root.bar ? root.bar.fontFamily : Style.font.family
              text: "Now"
              bordered: true
              enabled: root.scrubbed
              onClicked: root.resetScrub()
            }

            Button {
              foreground: root.bar ? root.bar.foreground : Color.foreground
              fontFamily: root.bar ? root.bar.fontFamily : Style.font.family
              bordered: true
              text: root.addingZone ? "Cancel" : "Add zone"
              onClicked: {
                root.addingZone = !root.addingZone
                if (root.addingZone) root.loadZoneList()
              }
            }
          }
        }

        // ---- Zone picker, only present while adding.
        Item {
          width: parent.width
          height: root.addingZone ? Style.space(44) : 0
          visible: root.addingZone
          clip: true

          SearchableDropdown {
            anchors.left: parent.left
            anchors.right: parent.right
            anchors.leftMargin: Style.space(16)
            anchors.rightMargin: Style.space(16)
            anchors.verticalCenter: parent.verticalCenter
            options: root.availableZones
            placeholderText: "Search timezones"
            showLabel: false
            fontFamily: root.bar ? root.bar.fontFamily : Style.font.family
            onChanged: function(value) { root.addZone(value) }
          }
        }

        Item { width: 1; height: Style.space(6) }
      }
    }
  }
  }
}
