#!/usr/bin/env bash
# macOS network shaper for the avatar weak-network probe (needs sudo; dnctl + pfctl ship with macOS).
#
# Chrome DevTools throttling does NOT touch WebRTC's UDP media, so the avatar stream must be shaped at
# the OS level. This shapes ALL non-loopback traffic of this machine (both the browser→Azure avatar
# WebRTC path and the backend→Azure Voice Live WebSocket), which approximates a candidate sitting on a
# constrained office network. Loopback (browser↔local backend, Playwright↔Chromium) is untouched.
#
#   sudo e2e/scripts/netshape.sh on <down_kbps> <up_kbps> <loss_pct> <delay_ms> [all|udp]
#     scope "udp" (default) shapes ONLY UDP = the avatar WebRTC media, which is exactly what crosses a
#     candidate's office network in production (the backend→Azure WebSocket is intra-Azure there).
#     scope "all" also shapes TCP — use it ONLY with loss 0, otherwise the backend's TLS handshake to
#     Azure times out on this dev box and no session is created at all (observed 2026-09-30).
#   sudo e2e/scripts/netshape.sh off
#   sudo e2e/scripts/netshape.sh status
#
# Suggested profiles (then run the probe with a matching PROFILE label):
#   office-ok     : on 4000 2000 0.5 50     # decent office Wi-Fi
#   office-tight  : on 1500 800  1   80     # shared uplink, VPN
#   office-bad    : on 800  400  3   120    # congested / hotspot
#   uplink-starved: on 4000 300  0.5 50     # asymmetric: is the 600 kbps mic uplink the first casualty?
set -euo pipefail

PIPE_DOWN=1
PIPE_UP=2
# Must live under com.apple/* — the stock /etc/pf.conf only evaluates `dummynet-anchor "com.apple/*"`.
ANCHOR="com.apple/weaknet"

usage() { sed -n 2,20p "$0"; exit 1; }
[[ $EUID -eq 0 ]] || { echo "run with sudo"; exit 1; }

case "${1:-}" in
  on)
    [[ $# -eq 5 || $# -eq 6 ]] || usage
    down=$2; up=$3; loss=$4; delay=$5; scope=${6:-udp}
    case "$scope" in udp) match="proto udp from any to any" ;; all) match="all" ;; *) usage ;; esac
    # dnctl wants plr as a fraction 0..1
    plr=$(awk -v p="$loss" 'BEGIN{printf "%.4f", p/100}')
    dnctl -q flush || true
    dnctl pipe $PIPE_DOWN config bw "${down}Kbit/s" delay "$delay" plr "$plr"
    dnctl pipe $PIPE_UP   config bw "${up}Kbit/s"   delay "$delay" plr "$plr"
    # Shape everything except loopback. pf 'dummynet' rules attach to the anchor.
    cat <<EOF | pfctl -q -a "$ANCHOR" -f -
dummynet in  quick on ! lo0 $match pipe $PIPE_DOWN
dummynet out quick on ! lo0 $match pipe $PIPE_UP
EOF
    pfctl -q -e 2>/dev/null || true
    echo "shaping ON  scope=$scope down=${down}kbps up=${up}kbps loss=${loss}% delay=${delay}ms (each way)"
    ;;
  off)
    pfctl -q -a "$ANCHOR" -F all 2>/dev/null || true
    dnctl -q flush || true
    echo "shaping OFF (pf left enabled; 'sudo pfctl -d' to disable pf entirely if it was off before)"
    ;;
  status)
    dnctl list 2>/dev/null || echo "no pipes"
    pfctl -q -a "$ANCHOR" -s rules 2>/dev/null || echo "no anchor rules"
    ;;
  *) usage ;;
esac
