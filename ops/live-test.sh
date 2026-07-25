#!/usr/bin/env bash
# Exercise a live deployment through every settlement route that can be reached
# without waiting out a real clock.
#
#   RPC_URL=... PK=... FACTORY=0x... REGISTRY=0x... ./ops/live-test.sh
#
# Driven with `cast` and explicit waits rather than a single multi-transaction
# `forge script`, deliberately: public testnet RPCs are load-balanced and their
# reads lag their own receipts, so a script that estimates gas for step N against
# a node that has not yet seen step N-1 will send a transaction that reverts. One
# transaction at a time, each confirmed before the next is built, is slower and
# actually works.
#
# What this cannot cover, and why: escheat needs 90 days of founder silence and a
# guardian redirect needs 7, both enforced by VotiveLimits. Neither is reachable
# on a live chain without waiting, so both are covered by the unit suite instead.

set -euo pipefail

: "${RPC_URL:?set RPC_URL}"
: "${PK:?set PK}"
: "${FACTORY:?set FACTORY}"
: "${REGISTRY:?set REGISTRY}"

EXTRA_FLAGS="${EXTRA_FLAGS:-}"
DEPOSIT="${DEPOSIT:-0.0004ether}"
OFFERING="${OFFERING:-0.0002ether}"
ME=$(cast wallet address --private-key "$PK")

pass=0
fail=0

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
step() { printf '  %-46s' "$*"; }
ok()   { printf '\033[32mok\033[0m %s\n' "${1:-}"; pass=$((pass + 1)); }
bad()  { printf '\033[31mFAILED\033[0m %s\n' "${1:-}"; fail=$((fail + 1)); }

# Addresses come back checksummed from some calls and lowercased from others, so
# comparisons are case-insensitive; every value being compared here is either a
# hex address or a decimal number, and neither is case-sensitive.
check() { # check <label> <actual> <expected>
  step "$1"
  local a b
  a=$(printf '%s' "$2" | tr 'A-Z' 'a-z')
  b=$(printf '%s' "$3" | tr 'A-Z' 'a-z')
  if [ "$a" = "$b" ]; then ok "($2)"; else bad "got $2, wanted $3"; fi
}

send() { cast send "$@" --rpc-url "$RPC_URL" --private-key "$PK" $EXTRA_FLAGS --json >/dev/null; sleep 5; }
call() { cast call "$@" --rpc-url "$RPC_URL" 2>/dev/null | tail -1 | awk '{print $1}'; }

# A votive's intent tuple, with a salt so repeat runs never collide.
intent() { # intent <capability> <condition> <story> <kind> <beneficiary> <fallback>
  echo "($4,$ME,0x0000000000000000000000000000000000000000,$5,$6,$1,$2,$3,0,false)"
}

open_votive() { # open_votive <intent> <value> -> address
  local before after
  before=$(call "$FACTORY" 'allVotivesLength()(uint256)')
  send "$FACTORY" \
    'open((uint8,address,address,address,address,bytes32,bytes32,bytes32,uint256,bool),(uint64,uint64,uint64),(uint16,uint16))(address)' \
    "$1" "(0,0,0)" "(65535,65535)" --value "$2"
  after=$(call "$FACTORY" 'allVotivesLength()(uint256)')
  [ "$after" -gt "$before" ] || { echo "open did not register a votive" >&2; exit 1; }
  call "$FACTORY" 'votiveAt(uint256)(address)' "$((after - 1))"
}

SALT=$(cast keccak "live-$(date +%s)-$RANDOM")
ZERO=0x0000000000000000000000000000000000000000

say "live test against $(call "$FACTORY" 'executor()(address)' >/dev/null && echo "$FACTORY")"
echo "  chain    $(cast chain-id --rpc-url "$RPC_URL")"
echo "  operator $ME"

# ---------------------------------------------------------------- route 1: redirect

say "route 1 — the founder redirects a live votive"
CAP=$(cast keccak "cap-r1-$SALT"); COND=$(cast keccak "cond-r1-$SALT")
V=$(open_votive "$(intent "$CAP" "$COND" "$(cast keccak "story-r1-$SALT")" 0 "$ZERO" "$ZERO")" "$DEPOSIT")
echo "  votive   $V"
check "opens in Waiting" "$(call "$V" 'state()(uint8)')" "1"
send "$V" 'redirect(address)' "$ME"
check "settles to Redirected" "$(call "$V" 'state()(uint8)')" "4"
check "holds nothing afterwards" "$(cast balance "$V" --rpc-url "$RPC_URL")" "0"
check "left the live set" "$(call "$FACTORY" 'isLive(address)(bool)' "$V")" "false"

# ------------------------------------------- route 2: offering, then the performance fee

say "route 2 — an offering is charged the performance fee, principal is not"
CAP=$(cast keccak "cap-r2-$SALT"); COND=$(cast keccak "cond-r2-$SALT")
TREASURY=$(cast wallet address --private-key "$(cast keccak "treasury-$SALT")")
send "$FACTORY" 'setTreasury(address)' "$TREASURY"
check "treasury rotated" "$(call "$FACTORY" 'treasury()(address)')" "$TREASURY"

V=$(open_votive "$(intent "$CAP" "$COND" "$(cast keccak "story-r2-$SALT")" 0 "$ZERO" "$ZERO")" "$DEPOSIT")
echo "  votive   $V"
send "$V" --value "$OFFERING"
OFFERED=$(call "$V" 'offerings()(uint256)')
step "the offering registers as a gain"; [ "$OFFERED" != "0" ] && ok "($OFFERED wei)" || bad "offerings() is 0"

send "$REGISTRY" 'attestCapability(bytes32,bytes32,bool,bytes32)' "$CAP" "$(cast keccak model)" true "$(cast keccak ev)"
send "$V" 'beginAttempt()'
send "$REGISTRY" 'attestCondition(address,bytes32,bool,bytes32)' "$V" "$COND" true "$(cast keccak ev)"
send "$V" 'fulfil()'

check "settles to Fulfilled" "$(call "$V" 'state()(uint8)')" "3"
check "holds nothing afterwards" "$(cast balance "$V" --rpc-url "$RPC_URL")" "0"
CHARGED=$(call "$V" 'performanceCharged()(uint256)')
EXPECTED=$((OFFERED * 800 / 10000))
check "performance fee is 8% of the gain" "$CHARGED" "$EXPECTED"
TREASURY_BAL=$(cast balance "$TREASURY" --rpc-url "$RPC_URL")
step "the treasury was actually paid"
[ "$TREASURY_BAL" != "0" ] && ok "($TREASURY_BAL wei)" || bad "treasury balance is 0"

# ------------------------------------------------------------- route 3: a top-up

say "route 3 — a top-up raises principal and is never performance-charged"
CAP=$(cast keccak "cap-r3-$SALT"); COND=$(cast keccak "cond-r3-$SALT")
V=$(open_votive "$(intent "$CAP" "$COND" "$(cast keccak "story-r3-$SALT")" 0 "$ZERO" "$ZERO")" "$DEPOSIT")
echo "  votive   $V"
P0=$(call "$V" 'principal()(uint256)')
send "$V" 'topUp()' --value "$OFFERING"
P1=$(call "$V" 'principal()(uint256)')
step "principal grew"; [ "$P1" -gt "$P0" ] && ok "($P0 -> $P1)" || bad "principal unchanged"
check "and it is not a gain" "$(call "$V" 'offerings()(uint256)')" "0"

send "$REGISTRY" 'attestCapability(bytes32,bytes32,bool,bytes32)' "$CAP" "$(cast keccak model)" true "$(cast keccak ev)"
send "$V" 'beginAttempt()'
send "$REGISTRY" 'attestCondition(address,bytes32,bool,bytes32)' "$V" "$COND" true "$(cast keccak ev)"
send "$V" 'fulfil()'
check "no performance fee on a top-up" "$(call "$V" 'performanceCharged()(uint256)')" "0"

# --------------------------------------------------------- route 4: gates refuse

say "route 4 — the gates refuse what they should"
CAP=$(cast keccak "cap-r4-$SALT"); COND=$(cast keccak "cond-r4-$SALT")
V=$(open_votive "$(intent "$CAP" "$COND" "$(cast keccak "story-r4-$SALT")" 0 "$ZERO" "$ZERO")" "$DEPOSIT")
echo "  votive   $V"
step "attempt refused while capability is closed"
if cast call "$V" 'beginAttempt()' --from "$ME" --rpc-url "$RPC_URL" >/dev/null 2>&1; then
  bad "it was allowed"
else ok; fi
step "escheat refused before the silence window"
if cast call "$V" 'escheat()' --from "$ME" --rpc-url "$RPC_URL" >/dev/null 2>&1; then
  bad "it was allowed"
else ok; fi
send "$REGISTRY" 'attestCapability(bytes32,bytes32,bool,bytes32)' "$CAP" "$(cast keccak model)" true "$(cast keccak ev)"
send "$V" 'beginAttempt()'
step "fulfil refused while the condition is unattested"
if cast call "$V" 'fulfil()' --from "$ME" --rpc-url "$RPC_URL" >/dev/null 2>&1; then
  bad "it was allowed"
else ok; fi
send "$V" 'redirect(address)' "$ME"   # tidy up: leave nothing parked

# ----------------------------------------------------------------------- summary

say "summary"
echo "  passed $pass"
echo "  failed $fail"
[ "$fail" -eq 0 ] || exit 1
