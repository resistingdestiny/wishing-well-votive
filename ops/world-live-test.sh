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
: "${AGENT_KEY:?set AGENT_KEY}"
: "${AGENT2_KEY:?set AGENT2_KEY}"
: "${FRESH_KEY:?set FRESH_KEY}"

AGENT=$(cast wallet address --private-key "$AGENT_KEY")
AGENT2=$(cast wallet address --private-key "$AGENT2_KEY")
FRESH=$(cast wallet address --private-key "$FRESH_KEY")
SUPPLIER=$(cast wallet address --private-key "$DEPLOYER_KEY")

# Salted per run so a re-run against a chain that keeps state does not collide
# with an operator this script already barred — which would make step 1 fail for
# a reason that has nothing to do with the code.
SALT="${SALT:-$$}"
OPERATOR=$(cast keccak "human:live-${SALT}")
INNOCENT=$(cast keccak "human:innocent-${SALT}")
CLEAN=$(cast keccak "human:clean-${SALT}")
EVIDENCE=$(cast keccak "evidence-${SALT}")

pass=0; fail=0
ok()   { pass=$((pass+1)); printf '  \033[32mok\033[0m   %s\n' "$1"; }
bad()  { fail=$((fail+1)); printf '  \033[31mFAIL\033[0m %s\n' "$1"; }
check(){ # check <label> <got> <want>
  local got want; got=$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]' | awk '{print $1}')
  want=$(printf '%s' "$3" | tr '[:upper:]' '[:lower:]')
  [ "$got" = "$want" ] && ok "$1" || bad "$1 (got '${got}' want '${want}')"
}
call(){ cast call "$@" --rpc-url "$RPC_URL" 2>/dev/null; }
send(){ cast send "$@" --rpc-url "$RPC_URL" >/dev/null 2>&1; }
must_fail(){ # must_fail <label> <cmd...>
  local label="$1"; shift
  if "$@" >/dev/null 2>&1; then bad "$label — it was allowed"; else ok "$label"; fi
}

attest(){ send "$HUMAN_REGISTRY" 'attest(address,bytes32,uint8,bytes32)' "$1" "$2" "$3" "$EVIDENCE" --private-key "$DEPLOYER_KEY"; }

echo
echo "  Human-backing layer, live on ${RPC_URL}"
echo "  ------------------------------------------------------"

echo "  before anyone is verified"
check "an unverified agent is not admitted" "$(call "$ACCESS_GATE" 'isPermitted(address)(bool)' "$AGENT")" "false"
check "an unverified agent has no allowance" "$(call "$COMMONS_POOL" 'ceilingOf(address)(uint256)' "$AGENT")" "0"

echo "  two wallets, one operator"
attest "$AGENT"  "$OPERATOR" 2
attest "$AGENT2" "$OPERATOR" 2
check "a verified agent is admitted" "$(call "$ACCESS_GATE" 'isPermitted(address)(bool)' "$AGENT")" "true"
check "both wallets resolve to one operator" "$(call "$HUMAN_REGISTRY" 'walletCount(bytes32)(uint256)' "$OPERATOR")" "2"

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
LEFT=$(call "$COMMONS_POOL" 'remainingOf(address)(uint256)' "$AGENT2" | awk '{print $1}')
check "the second wallet sees the first's spend" "$LEFT" "$((CEILING - DRAW))"
must_fail "the second wallet cannot overdraw the shared budget" \
  cast send "$COMMONS_POOL" 'draw(uint256,address)' "$CEILING" "$SUPPLIER" --rpc-url "$RPC_URL" --private-key "$AGENT2_KEY"

echo "  a wish asking for somebody to be killed"
send "$STANDING_LEDGER" 'reportConduct(bytes32,uint8,uint8,bytes32)' \
  "$OPERATOR" 1 3 "$(cast keccak "wish:have-this-person-killed-${SALT}")" --private-key "$DEPLOYER_KEY"
check "the operator is barred" "$(call "$STANDING_LEDGER" 'isBarred(bytes32)(bool)' "$OPERATOR")" "true"
check "their standing multiplier is zero" "$(call "$STANDING_LEDGER" 'multiplierBpsOf(bytes32)(uint256)' "$OPERATOR")" "0"
check "the first wallet is locked out" "$(call "$ACCESS_GATE" 'isPermitted(address)(bool)' "$AGENT")" "false"
check "so is the second" "$(call "$ACCESS_GATE" 'isPermitted(address)(bool)' "$AGENT2")" "false"
check "the commons is closed to both" "$(call "$COMMONS_POOL" 'ceilingOf(address)(uint256)' "$AGENT2")" "0"

echo "  and the ways out of a bar that must not work"
attest "$FRESH" "$OPERATOR" 3
check "a brand-new wallet is still locked out" "$(call "$ACCESS_GATE" 'isPermitted(address)(bool)' "$FRESH")" "false"
check "a brand-new wallet draws nothing" "$(call "$COMMONS_POOL" 'ceilingOf(address)(uint256)' "$FRESH")" "0"
must_fail "a new keypair is not a new start" \
  cast send "$COMMONS_POOL" 'draw(uint256,address)' 1000 "$SUPPLIER" --rpc-url "$RPC_URL" --private-key "$FRESH_KEY"
must_fail "an existing wallet cannot be relabelled onto a clean identifier" \
  cast send "$HUMAN_REGISTRY" 'attest(address,bytes32,uint8,bytes32)' "$AGENT" "$CLEAN" 3 "$EVIDENCE" --rpc-url "$RPC_URL" --private-key "$DEPLOYER_KEY"

echo "  one operator's disgrace is not another's"
INNOCENT_WALLET=$(cast wallet address --private-key "$(cast keccak "innocent-key-${SALT}")" 2>/dev/null || echo "")
if [ -n "$INNOCENT_WALLET" ]; then
  attest "$INNOCENT_WALLET" "$INNOCENT" 2
  check "an unrelated operator is still admitted" "$(call "$ACCESS_GATE" 'isPermitted(address)(bool)' "$INNOCENT_WALLET")" "true"
  check "and still has an allowance" "$(call "$COMMONS_POOL" 'ceilingOf(address)(uint256)' "$INNOCENT_WALLET")" "$CEILING"
fi

echo "  ------------------------------------------------------"
printf '  %d passed, %d failed\n\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
