#!/bin/bash
# RULE 29 LIVE-ACCEPTANCE — adb/uiautomator helpers for OUR acceptance AVD.
#
# Serial comes from $LA_SERIAL (default emulator-5584). Never targets a real
# device: `adb -s` is always explicit.
#
# Hardening over the 20260923T1512Z session helper:
#  - `pick`/`save` drive the app's OWN SAF pickers (ACTION_OPEN_DOCUMENT from
#    the Home "Send a file" row, ACTION_CREATE_DOCUMENT on Accept). The old
#    `share` path (`am start -a SEND --eu EXTRA_STREAM`) hands the app a
#    shell-granted MediaStore URI it cannot read: the confirm dialog shows an
#    EMPTY filename and SEND emits no FILE_OFFER. `share` is kept only to
#    reproduce that, never to prove a transfer.
#  - `sendfile` = the real in-app entry: tap homeSendFileButton (vc63 COMPUTER
#    card row A -> FileTransferActivity.ACTION_PICK_FILE).
#  - `push` media-scans what it pushes so the picker can see it.
#  - `sha` hashes a file on the device for a both-ends digest comparison.
set -u
export MSYS_NO_PATHCONV=1
ADB="${LA_ADB:-$LOCALAPPDATA/Android/Sdk/platform-tools/adb.exe}"
S="${LA_SERIAL:-emulator-5584}"
PKG=com.dnkdialer.companion

a() { "$ADB" -s "$S" "$@"; }
dump() { a shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1; a shell cat /sdcard/ui.xml; }

# tap the centre of the first node whose $2 attribute matches $1
tapattr() {
  local attr="$1" val="$2"
  local x
  x=$(dump | tr '>' '\n' | grep "$attr=\"[^\"]*$val\"" \
      | grep -o 'bounds="\[[0-9]*,[0-9]*\]\[[0-9]*,[0-9]*\]"' | head -1)
  [ -z "$x" ] && { echo "NOMATCH $attr~$val"; return 1; }
  local n; n=$(echo "$x" | grep -o '[0-9]*' | tr '\n' ' ')
  set -- $n
  a shell input tap $(( ($1+$3)/2 )) $(( ($2+$4)/2 ))
  echo "tapped $attr~$val -> $(( ($1+$3)/2 )),$(( ($2+$4)/2 ))"
}
tapid()   { tapattr 'resource-id' "$1"; }
taptext() { tapattr 'text' "$1"; }

case "${1:-}" in
  dump)  dump | tr '>' '\n' | grep -o 'resource-id="[^"]*"\|text="[^"]*"' | grep -v '""' | head -80 ;;
  tap)   tapid "$2" ;;
  taptext) taptext "$2" ;;
  type)  tapid "$2" && a shell input text "$3" ;;
  start) a shell am start -n $PKG/.MainActivity ;;
  stop)  a shell am force-stop $PKG ;;
  restart) a shell am force-stop $PKG; sleep 2; a shell am start -n $PKG/.MainActivity ;;
  sms)   a emu sms send "$2" "$3" ;;
  call)  a emu gsm call "$2" ;;
  hangup) a emu gsm cancel "$2" ;;

  # push + media-scan so ACTION_OPEN_DOCUMENT can actually list it
  push)  a push "$2" /sdcard/Download/ && \
         a shell am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE \
           -d "file:///sdcard/Download/$(basename "$2")" >/dev/null && \
         echo "pushed+scanned /sdcard/Download/$(basename "$2")" ;;

  # phone -> ext: the app's own picker, via the Home row that fires ACTION_PICK_FILE
  sendfile) tapid 'homeSendFileButton' ;;
  pickintent) a shell am start -n $PKG/.FileTransferActivity -a $PKG.FT_PICK ;;
  # inside ACTION_OPEN_DOCUMENT: choose a file by visible name
  pick)  taptext "$2" ;;
  # inside ACTION_CREATE_DOCUMENT (Accept destination): commit with SAVE
  save)  taptext 'SAVE' || taptext 'Save' ;;

  sha)   a shell sha256sum "$2" ;;
  ls)    a shell ls -l "${2:-/sdcard/Download}" ;;
  shot)  a exec-out screencap -p > "$2" ;;
  log)   a logcat -d -t 400 | grep -iE "$2" | tail -40 ;;

  # kept ONLY to reproduce the empty-name defect; never a transfer proof
  share) a shell am start -n $PKG/.FileTransferActivity -a android.intent.action.SEND \
           -t "*/*" --eu android.intent.extra.STREAM "$2" ;;
  *)     a "$@" ;;
esac
