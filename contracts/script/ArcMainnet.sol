// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

/// @notice Arc mainnet (chainId 5042) addresses, from https://docs.arc.io/arc/references/contract-addresses.md
/// ERC-8004 registries checked by RPC on 2026-10-10 (v2.0.0, canonical vanity addresses).
library ArcMainnet {
    uint256 internal constant CHAIN_ID = 5042;
    address internal constant USDC = 0x3600000000000000000000000000000000000000; // ERC-20 interface, 6 decimals
    address internal constant EURC = 0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1;
    address internal constant IDENTITY_REGISTRY = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;
    address internal constant REPUTATION_REGISTRY = 0x8004BAa17C55a88189AE136b182e5fdA19dE9b63;
    address internal constant MEMO = 0x5294E9927c3306DcBaDb03fe70b92e01cCede505;
    address internal constant MULTICALL3_FROM = 0x522fAf9A91c41c443c66765030741e4AaCe147D0;
}
