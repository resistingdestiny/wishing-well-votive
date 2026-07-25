// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice A minimal Merkle tree over share allocations, for tests.
/// @dev Pairs are hashed in sorted order and an odd node is promoted unchanged,
///      which is what OpenZeppelin's `MerkleProof.verify` expects. Leaves are
///      hashed twice — `keccak256(bytes.concat(keccak256(abi.encode(...))))` —
///      so that no internal node can ever be mistaken for a leaf, which is what
///      stops somebody presenting an intermediate hash as a claim.
library Merkle {
    function leafOf(uint256 index, address account, uint256 weight)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(bytes.concat(keccak256(abi.encode(index, account, weight))));
    }

    function leaves(address[] memory accounts, uint256[] memory weights)
        internal
        pure
        returns (bytes32[] memory out)
    {
        out = new bytes32[](accounts.length);
        for (uint256 i = 0; i < accounts.length; i++) {
            out[i] = leafOf(i, accounts[i], weights[i]);
        }
    }

    function root(bytes32[] memory nodes) internal pure returns (bytes32) {
        require(nodes.length > 0, "empty tree");
        bytes32[] memory level = nodes;
        while (level.length > 1) {
            level = _nextLevel(level);
        }
        return level[0];
    }

    function proof(bytes32[] memory nodes, uint256 index)
        internal
        pure
        returns (bytes32[] memory path)
    {
        require(index < nodes.length, "index out of range");

        // Depth is bounded by the tree height; trim at the end.
        bytes32[] memory scratch = new bytes32[](32);
        uint256 depth;

        bytes32[] memory level = nodes;
        uint256 position = index;
        while (level.length > 1) {
            uint256 sibling = position ^ 1;
            if (sibling < level.length) {
                scratch[depth] = level[sibling];
                depth++;
            }
            level = _nextLevel(level);
            position /= 2;
        }

        path = new bytes32[](depth);
        for (uint256 i = 0; i < depth; i++) {
            path[i] = scratch[i];
        }
    }

    function _nextLevel(bytes32[] memory level) private pure returns (bytes32[] memory next) {
        uint256 width = (level.length + 1) / 2;
        next = new bytes32[](width);
        for (uint256 i = 0; i < width; i++) {
            uint256 left = i * 2;
            uint256 right = left + 1;
            next[i] = right < level.length ? _hashPair(level[left], level[right]) : level[left];
        }
    }

    function _hashPair(bytes32 a, bytes32 b) private pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }
}
