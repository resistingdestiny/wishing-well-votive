// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ResourceRegistry} from "../src/world/ResourceRegistry.sol";
import {AssuranceTiers} from "../src/world/AssuranceTiers.sol";
import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";

/// @notice Registers the toolbelt resources the agent platform speaks for, into a
///         `ResourceRegistry` this deployment already owns.
///
/// @dev **The resource id is the whole point of this file, and it is not this
///      file's to invent.** The app derives it in `src/core/skills/resourceId.ts`
///      as `keccak256(utf8("resource:" + slug))`; the agent asking for access
///      derives it the same way; and if this script derived it any differently the
///      registry would answer `NoSuchResource` for an id nobody registered — which
///      on screen reads "this resource is not available to you", a sentence about
///      the operator produced by a bug in our hashing. So `_idOf` computes exactly
///      `keccak256(bytes(string.concat("resource:", slug)))`, the same bytes viem's
///      `keccak256(toBytes(...))` sees, and the invariant test
///      `AgentPlatformInvariants.t.sol` pins the two against a hardcoded vector.
///
///      Idempotent: a slug already registered (its provider is non-zero) is left
///      alone rather than re-registered, because `register` reverts
///      `AlreadyRegistered` and the live corpus is already there. Re-running this
///      after adding a slug registers only the new one.
///
///      The base limit and minimum assurance for each slug are facts about the
///      catalogue in this same repository (`src/core/skills/catalogue.ts`, the
///      `TOOLBELT` array's `intendedBaseLimit` / `intendedMinAssurance`), copied
///      here so the on-chain resource matches what the page promises. They are not
///      configurable from the environment for the same reason the id is not: a
///      resource whose terms differ between the page and the chain is the exact
///      divergence this file exists to prevent.
///
///      Usage:
///
///        forge script script/RegisterResources.s.sol:RegisterResources \
///          --rpc-url "$RPC_URL" --account deployer --broadcast
///
///      Required environment:
///
///        VOTIVE_RESOURCE_REGISTRY   the registry to populate (owner-only calls)
///
///      Optional environment:
///
///        VOTIVE_RESOURCE_PROVIDER   who releases the credentials  (default: sender)
contract RegisterResources is Script {
    /// @dev Mirror of `RESOURCE_ID_PREFIX` in `src/core/skills/resourceId.ts`.
    string internal constant PREFIX = "resource:";

    /// @dev One row of the catalogue's `TOOLBELT`, carried through the script so
    ///      the reporting and the registration read from a single source.
    struct Item {
        string slug;
        uint32 baseLimit;
        uint8 minAssurance;
    }

    function run() external {
        ResourceRegistry registry = ResourceRegistry(vm.envAddress("VOTIVE_RESOURCE_REGISTRY"));
        address provider = vm.envOr("VOTIVE_RESOURCE_PROVIDER", msg.sender);

        // The three toolbelt items from `catalogue.ts`. `linear-a-corpus-api` is
        // already live on Base Sepolia (baseLimit 5, minAssurance DEVICE); it is
        // listed so a fresh deployment reproduces it and an existing one skips it.
        Item[] memory items = new Item[](3);
        items[0] = Item("linear-a-corpus-api", 5, AssuranceTiers.DEVICE);
        items[1] = Item("votive-run-log-db", 3, AssuranceTiers.DEVICE);
        items[2] = Item("frontier-model-key", 2, AssuranceTiers.SELFIE);

        console.log("");
        console.log("  Registering toolbelt resources into %s", address(registry));
        console.log("  provider %s", provider);
        console.log("  ------------------------------------------------------");

        vm.startBroadcast();
        for (uint256 i = 0; i < items.length; i++) {
            Item memory item = items[i];
            bytes32 id = _idOf(item.slug);

            // A registered resource has a non-zero provider. Skipping rather than
            // calling `register` avoids the `AlreadyRegistered` revert and lets the
            // script be the reproducible record for a chain that keeps its state.
            if (registry.resourceOf(id).provider != address(0)) {
                console.log("  -- %s already registered", item.slug);
                continue;
            }

            registry.register(id, provider, item.baseLimit, item.minAssurance, _termsOf(item.slug));
            console.log("  ok %s", item.slug);
            console.logBytes32(id);
        }
        vm.stopBroadcast();
        console.log("  ------------------------------------------------------");
        console.log("");
    }

    /// @notice `keccak256("resource:" + slug)` — byte-identical to the app's
    ///         `resourceIdOf`, verified against a fixed vector in the invariants.
    function _idOf(string memory slug) internal pure returns (bytes32) {
        return keccak256(bytes(string.concat(PREFIX, slug)));
    }

    /// @dev A commitment to the off-chain terms of use, one per resource so a
    ///      change to one slug's terms does not silently move another's. The
    ///      credential and the terms document both live off chain; only this hash
    ///      of them is written down.
    function _termsOf(string memory slug) internal pure returns (bytes32) {
        return keccak256(bytes(string.concat("resource-terms:", slug)));
    }
}
