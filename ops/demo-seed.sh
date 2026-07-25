#!/usr/bin/env bash
#
# Exercise every integration once and record each transaction, so a fresh
# deployment has something real to show.
#
# This does not fabricate anything. Each step sends a genuine transaction and then
# tells the app about it through the same endpoint the browser uses — the record
# and the chain cannot disagree, because the record is only written after the
# chain has accepted it.
#
# Safe to re-run. Attestation is idempotent for the same human, and the rest are
# additional real actions.
#
#   ops/demo-seed.sh
#
# Environment (normally from .env.local):
#   APP_URL              defaults to http://127.0.0.1:3100
#   BASE_SEPOLIA_RPC_URL, BASE_SEPOLIA_PK   the owner/attestor/reviewer key
#   DEMO_WALLET_ADDRESS, DEMO_WALLET_PK     the wallet acting as the agent
#   NEXT_PUBLIC_WELL_*                      deployed addresses

set -uo pipefail

APP_URL="${APP_URL:-http://127.0.0.1:3100}"
RPC="${BASE_SEPOLIA_RPC_URL:?set BASE_SEPOLIA_RPC_URL}"
OWNER_PK="${BASE_SEPOLIA_PK:?set BASE_SEPOLIA_PK}"
AGENT="${DEMO_WALLET_ADDRESS:?set DEMO_WALLET_ADDRESS}"
AGENT_PK="${DEMO_WALLET_PK:?set DEMO_WALLET_PK}"

HR="${NEXT_PUBLIC_WELL_HUMAN_REGISTRY:?}"
SL="${NEXT_PUBLIC_WELL_STANDING_LEDGER:?}"
CP="${NEXT_PUBLIC_WELL_COMMONS_POOL:?}"
RR="${NEXT_PUBLIC_WELL_RESOURCE_REGISTRY:?}"

OWNER=$(cast wallet address --private-key "$OWNER_PK")

# Use whatever human this wallet is already bound to. Forcing a fresh identifier
# is refused by the registry on purpose — rebinding a wallet is how a barred
# operator would launder itself onto a clean record — so re-running this script
# must adopt the existing binding rather than fight it.
EXISTING=$(cast call "$HR" 'humanOf(address)(bytes32)' "$AGENT" --rpc-url "$RPC" 2>/dev/null | awk '{print $1}')
ZERO_WORD="0x0000000000000000000000000000000000000000000000000000000000000000"
if [ -n "$EXISTING" ] && [ "$EXISTING" != "$ZERO_WORD" ]; then
  HUMAN="$EXISTING"
  ALREADY_BOUND=1
else
  HUMAN=$(cast keccak "human:demo-operator")
  ALREADY_BOUND=0
fi
# The operator who asks for harm is deliberately NOT the demo wallet: barring the
# wallet the demo runs on would leave nothing to demonstrate afterwards.
MALLORY=$(cast keccak "human:operator-who-asked-for-harm")
CORPUS=$(cast keccak "resource:linear-a-corpus-api")
EV=$(cast keccak "evidence")

ok=0; failed=0; skipped=0

skip() { skipped=$((skipped+1)); printf '  \033[33m--\033[0m   %-46s %s\n' "$1" "$2"; }

note() { # note <kind> <txhash> <detail> <contract> [subject]
  curl -s -o /dev/null -X POST "$APP_URL/api/tx" \
    -H 'content-type: application/json' \
    -d "{\"kind\":\"$1\",\"chain\":\"base-sepolia\",\"txHash\":\"$2\",\"detail\":\"$3\",\"contract\":\"$4\"${5:+,\"subject\":\"$5\"}}"
}

# send <label> <note-kind> <detail> <pk> <to> <sig> [args...]
send() {
  local label="$1" kind="$2" detail="$3" pk="$4" to="$5"; shift 5
  local out hash
  if ! out=$(cast send "$to" "$@" --rpc-url "$RPC" --private-key "$pk" --json 2>&1); then
    failed=$((failed+1))
    printf '  \033[31mFAIL\033[0m %s\n' "$label"
    printf '       %s\n' "$(printf '%s' "$out" | sed -E 's/0x[0-9a-fA-F]{64}/<redacted>/g' | tail -2)"
    return 1
  fi
  # A public endpoint serves the nonce from a replica that has not seen our last
  # transaction, so back-to-back sends from one key collide. Pause rather than
  # race; this script is not on a hot path.
  sleep 3
  hash=$(printf '%s' "$out" | python3 -c "import sys,json;print(json.load(sys.stdin).get('transactionHash',''))" 2>/dev/null)
  if [ -z "$hash" ]; then
    failed=$((failed+1)); printf '  \033[31mFAIL\033[0m %s (no hash)\n' "$label"; return 1
  fi
  ok=$((ok+1))
  printf '  \033[32mok\033[0m   %-46s %s\n' "$label" "${hash:0:14}…"
  [ -n "$kind" ] && note "$kind" "$hash" "$detail" "$to" "$AGENT"
  return 0
}

echo
echo "  Seeding a demo deployment on Base Sepolia"
echo "  ------------------------------------------------------"

# Roles first, and not recorded: they are setup, not something to show a judge.
send "grant the recorder role"  "" "" "$OWNER_PK" "$SL" 'setRecorder(address,bool)' "$OWNER" true >/dev/null
send "grant the reviewer role"  "" "" "$OWNER_PK" "$SL" 'setReviewer(address,bool)' "$OWNER" true >/dev/null

if [ "$ALREADY_BOUND" = "1" ]; then
  skip "bind the agent wallet to a verified human" "already bound to ${HUMAN:0:12}…"
else
  send "bind the agent wallet to a verified human" \
    "human-attested" "tier selfie · wallet $AGENT" \
    "$OWNER_PK" "$HR" 'attest(address,bytes32,uint8,bytes32)' "$AGENT" "$HUMAN" 2 "$EV"
fi

send "record a delivered fulfilment" \
  "" "" "$OWNER_PK" "$SL" 'recordFulfilment(bytes32)' "$HUMAN"

send "draw shared capital to pay a supplier" \
  "commons-drawn" "0.002 ETH to a supplier" \
  "$AGENT_PK" "$CP" 'draw(uint256,address)' 2000000000000000 "$OWNER"

RESOURCE_PROVIDER=$(cast call "$RR" 'resourceOf(bytes32)((address,uint32,uint8,bool,bytes32))' "$CORPUS" --rpc-url "$RPC" 2>/dev/null | grep -oE '0x[0-9a-fA-F]{40}' | head -1)
if [ -n "$RESOURCE_PROVIDER" ] && [ "$RESOURCE_PROVIDER" != "0x0000000000000000000000000000000000000000" ]; then
  skip "register a shared resource" "already registered"
else
  send "register a shared resource" \
    "" "" "$OWNER_PK" "$RR" 'register(bytes32,address,uint32,uint8,bytes32)' \
    "$CORPUS" "$OWNER" 5 1 "$(cast keccak "terms")"
fi

send "grant the agent access to it" \
  "resource-granted" "licensed corpus API · credential released off-chain" \
  "$AGENT_PK" "$RR" 'requestAccess(bytes32)' "$CORPUS"

send "bar a different operator for a violent wish" \
  "conduct-reported" "violence against people · permanent bar" \
  "$OWNER_PK" "$SL" 'reportConduct(bytes32,uint8,uint8,bytes32)' \
  "$MALLORY" 1 3 "$(cast keccak "wish:have-this-person-killed")"

echo "  ------------------------------------------------------"
printf '  %d sent, %d already done, %d failed\n\n' "$ok" "$skipped" "$failed"
[ "$failed" -eq 0 ]
