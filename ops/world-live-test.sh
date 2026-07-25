#!/usr/bin/env bash
#
# Exercises the human-backing layer against a running chain.
#
# The Solidity suite proves the same properties far more thoroughly. This exists
# for the thing a test suite cannot tell you: that the contracts as *deployed*,
# reached over RPC by a separate process paying real gas, behave the way the
# suite says they do. Deployment wiring, role grants and revert decoding are all
# places where a green suite and a broken deployment coexist happily.
#
# Deliberately `cast` rather than a multi-transaction forge script: public RPC
# reads lag their own receipts, and a script that assumes otherwise fails in ways
# that look like contract bugs.
#
#   ops/world-live-test.sh
#
# Environment:
#   RPC_URL             defaults to a local anvil
#   DEPLOYER_KEY        owner/attestor/reviewer key
#   AGENT_KEY           an agent wallet's key
#   AGENT2_KEY          a second wallet for the SAME operator
#   FRESH_KEY           a third, attested only after the bar
#   HUMAN_REGISTRY, STANDING_LEDGER, COMMONS_POOL, ACCESS_GATE

set -uo pipefail

RPC_URL="${RPC_URL:-http://127.0.0.1:8545}"

: "${HUMAN_REGISTRY:?set HUMAN_REGISTRY}"
: "${STANDING_LEDGER:?set STANDING_LEDGER}"
: "${COMMONS_POOL:?set COMMONS_POOL}"
: "${ACCESS_GATE:?set ACCESS_GATE}"
: "${DEPLOYER_KEY:?set DEPLOYER_KEY}"

# Everything is salted per run, wallets included.
#
# The first version took fixed agent keys, which cannot work twice against a chain
# that keeps its state: the opening assertion is that these wallets are *not*
# verified, and by the end of a run they are. Worse, re-attesting them to a fresh
# operator is refused by design, so the second run failed in a way that looked
# like a contract bug and was actually the contract being right.
SALT="${SALT:-$(date +%s)-$$}"

AGENT_KEY="${AGENT_KEY:-$(cast keccak "votive-agent-1-${SALT}")}"
AGENT2_KEY="${AGENT2_KEY:-$(cast keccak "votive-agent-2-${SALT}")}"
FRESH_KEY="${FRESH_KEY:-$(cast keccak "votive-agent-3-${SALT}")}"

AGENT=$(cast wallet address --private-key "$AGENT_KEY")
AGENT2=$(cast wallet address --private-key "$AGENT2_KEY")
FRESH=$(cast wallet address --private-key "$FRESH_KEY")
SUPPLIER=$(cast wallet address --private-key "$DEPLOYER_KEY")
OPERATOR=$(cast keccak "human:live-${SALT}")
INNOCENT=$(cast keccak "human:innocent-${SALT}")
CLEAN=$(cast keccak "human:clean-${SALT}")
EVIDENCE=$(cast keccak "evidence-${SALT}")

pass=0; fail=0
ok()   { pass=$((pass+1)); printf '  \033[32mok\033[0m   %s\n' "$1"; }
bad()  { fail=$((fail+1)); printf '  \033[31mFAIL\033[0m %s\n' "$1"; }
call(){ cast call "$@" --rpc-url "$RPC_URL" 2>/dev/null; }

# How many times to re-read before believing a disagreement, and how long to wait
# between tries. Public RPC endpoints serve reads from replicas that lag the node
# which just handed back a receipt, so a value read immediately after a write is
# routinely the value from before it. Locally the first read matches and this
# costs nothing; against a public endpoint it is the difference between a real
# assertion and a coin flip.
READ_TRIES="${READ_TRIES:-10}"
READ_DELAY="${READ_DELAY:-3}"

normalise(){ printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | awk '{print $1}'; }

check_call(){ # check_call <label> <want> <address> <sig> [args...]
  local label="$1" want; want=$(normalise "$2"); shift 2
  local got=""
  for _ in $(seq 1 "$READ_TRIES"); do
    got=$(normalise "$(call "$@")")
    [ "$got" = "$want" ] && { ok "$label"; return 0; }
    sleep "$READ_DELAY"
  done
  bad "$label (got '${got}' want '${want}')"
  return 1
}
# Never let a key reach the output. The arguments to every send include
# `--private-key`, and an earlier version printed them verbatim on failure — which
# put a working key into the terminal, and would have put it into any CI log that
# captured a failing run.
redact(){
  printf '%s' "$*" | sed -E 's/(--private-key)[[:space:]]+[^[:space:]]+/\1 <redacted>/g; s/0x[0-9a-fA-F]{64}/<redacted>/g'
}

# A write that fails must say so. An earlier version sent everything to
# /dev/null, so an attestation that never landed looked exactly like one that did
# and the failure only showed up three assertions later as a puzzling zero.
#
# Retries on a stale nonce. Public endpoints answer `eth_getTransactionCount` from
# a replica that has not yet seen the caller's previous transaction, so two sends
# in quick succession from one key routinely collide — which is a property of the
# endpoint, not of anything being tested.
send(){
  local out attempt=0
  while [ "$attempt" -lt 5 ]; do
    attempt=$((attempt + 1))
    if out=$(cast send "$@" --rpc-url "$RPC_URL" 2>&1); then
      case "$out" in
        *"status               0"*) bad "transaction reverted: $(redact "$@")"; return 1 ;;
      esac
      return 0
    fi
    case "$out" in
      *"nonce too low"*|*"replacement transaction underpriced"*|*"already known"*)
        sleep "$((attempt * 2))"; continue ;;
      *) break ;;
    esac
  done
  bad "transaction failed: $(redact "$@")"
  printf '       %s\n' "$(redact "$(printf '%s' "$out" | tail -3)")"
  return 1
}
must_fail(){ # must_fail <label> <cmd...>
  local label="$1"; shift
  if "$@" >/dev/null 2>&1; then bad "$label — it was allowed"; else ok "$label"; fi
}

attest(){ send "$HUMAN_REGISTRY" 'attest(address,bytes32,uint8,bytes32)' "$1" "$2" "$3" "$EVIDENCE" --private-key "$DEPLOYER_KEY"; }

echo
echo "  Human-backing layer, live on ${RPC_URL}"
echo "  ------------------------------------------------------"

# The agent wallets are new, so they hold nothing. They need gas of their own
# because the whole point is that *they* call draw, not the deployer on their
# behalf — an allowance checked against whoever paid for the transaction would
# prove nothing about the allowance.
GAS_TOPUP="${GAS_TOPUP:-2000000000000000}"
for key in "$AGENT_KEY" "$AGENT2_KEY" "$FRESH_KEY"; do
  wallet=$(cast wallet address --private-key "$key")
  if [ "$(call_balance=$(cast balance "$wallet" --rpc-url "$RPC_URL" 2>/dev/null); echo "${call_balance:-0}")" = "0" ]; then
    send "$wallet" --value "$GAS_TOPUP" --private-key "$DEPLOYER_KEY" >/dev/null || true
  fi
done

echo "  before anyone is verified"
check_call "an unverified agent is not admitted" "false" "$ACCESS_GATE" 'isPermitted(address)(bool)' "$AGENT"
check_call "an unverified agent has no allowance" "0" "$COMMONS_POOL" 'ceilingOf(address)(uint256)' "$AGENT"

echo "  two wallets, one operator"
attest "$AGENT"  "$OPERATOR" 2
attest "$AGENT2" "$OPERATOR" 2
check_call "a verified agent is admitted" "true" "$ACCESS_GATE" 'isPermitted(address)(bool)' "$AGENT"
check_call "both wallets resolve to one operator" "2" "$HUMAN_REGISTRY" 'walletCount(bytes32)(uint256)' "$OPERATOR"

CEILING=$(call "$COMMONS_POOL" 'ceilingOf(address)(uint256)' "$AGENT" | awk '{print $1}')
echo "  allowance this epoch: ${CEILING} wei"

# Stop here if the setup did not take. Every later assertion compares numbers
# derived from this allowance, and against a zero ceiling most of them pass
# trivially — an earlier version of this script reported fourteen greens on a
# chain where nothing had been attested at all. The likeliest cause is a wallet
# already bound to a different operator from a previous run, which the registry
# refuses on purpose; run against a fresh chain, or use different wallets.
if [ "${CEILING:-0}" = "0" ] || [ "$fail" -ne 0 ]; then
  echo
  echo "  ABORTING: the operator was not set up, so nothing below would mean anything."
  echo "  humanOf(agent)  = $(call "$HUMAN_REGISTRY" 'humanOf(address)(bytes32)' "$AGENT")"
  echo "  expected        = ${OPERATOR}"
  echo "  If those differ, these wallets belong to another operator already."
  echo
  exit 1
fi

echo "  the commons is metered per operator, not per wallet"
DRAW=$((CEILING * 7 / 10))
send "$COMMONS_POOL" 'draw(uint256,address)' "$DRAW" "$SUPPLIER" --private-key "$AGENT_KEY"
check_call "the second wallet sees the first's spend" "$((CEILING - DRAW))" "$COMMONS_POOL" 'remainingOf(address)(uint256)' "$AGENT2"
must_fail "the second wallet cannot overdraw the shared budget" \
  cast send "$COMMONS_POOL" 'draw(uint256,address)' "$CEILING" "$SUPPLIER" --rpc-url "$RPC_URL" --private-key "$AGENT2_KEY"

echo "  a wish asking for somebody to be killed"
send "$STANDING_LEDGER" 'reportConduct(bytes32,uint8,uint8,bytes32)' \
  "$OPERATOR" 1 3 "$(cast keccak "wish:have-this-person-killed-${SALT}")" --private-key "$DEPLOYER_KEY"
check_call "the operator is barred" "true" "$STANDING_LEDGER" 'isBarred(bytes32)(bool)' "$OPERATOR"
check_call "their standing multiplier is zero" "0" "$STANDING_LEDGER" 'multiplierBpsOf(bytes32)(uint256)' "$OPERATOR"
check_call "the first wallet is locked out" "false" "$ACCESS_GATE" 'isPermitted(address)(bool)' "$AGENT"
check_call "so is the second" "false" "$ACCESS_GATE" 'isPermitted(address)(bool)' "$AGENT2"
check_call "the commons is closed to both" "0" "$COMMONS_POOL" 'ceilingOf(address)(uint256)' "$AGENT2"

echo "  and the ways out of a bar that must not work"
attest "$FRESH" "$OPERATOR" 3
check_call "a brand-new wallet is still locked out" "false" "$ACCESS_GATE" 'isPermitted(address)(bool)' "$FRESH"
check_call "a brand-new wallet draws nothing" "0" "$COMMONS_POOL" 'ceilingOf(address)(uint256)' "$FRESH"
must_fail "a new keypair is not a new start" \
  cast send "$COMMONS_POOL" 'draw(uint256,address)' 1000 "$SUPPLIER" --rpc-url "$RPC_URL" --private-key "$FRESH_KEY"
must_fail "an existing wallet cannot be relabelled onto a clean identifier" \
  cast send "$HUMAN_REGISTRY" 'attest(address,bytes32,uint8,bytes32)' "$AGENT" "$CLEAN" 3 "$EVIDENCE" --rpc-url "$RPC_URL" --private-key "$DEPLOYER_KEY"

echo "  one operator's disgrace is not another's"
INNOCENT_WALLET=$(cast wallet address --private-key "$(cast keccak "innocent-key-${SALT}")" 2>/dev/null || echo "")
if [ -n "$INNOCENT_WALLET" ]; then
  attest "$INNOCENT_WALLET" "$INNOCENT" 2
  check_call "an unrelated operator is still admitted" "true" "$ACCESS_GATE" 'isPermitted(address)(bool)' "$INNOCENT_WALLET"
  check_call "and still has an allowance" "$CEILING" "$COMMONS_POOL" 'ceilingOf(address)(uint256)' "$INNOCENT_WALLET"
fi

echo "  ------------------------------------------------------"
printf '  %d passed, %d failed\n\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
