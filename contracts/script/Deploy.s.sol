// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {DocumentaryCredit, IIdentityRegistry, IReputationRegistry} from "../src/DocumentaryCredit.sol";
import {ArcMainnet} from "./ArcMainnet.sol";

/// Mainnet:
///   TREASURY=0x... arc-forge script script/Deploy.s.sol --rpc-url arc --account <keystore> --broadcast
/// The deployer becomes the owner (fee and treasury settings). FEE_BPS defaults to 25 (0.25%), capped at 100 by the contract.
/// The same addresses exist on Arc testnet for the ERC-8004 registries; pass USDC/EURC through env to override.
contract Deploy is Script {
    function run() external returns (DocumentaryCredit dc) {
        IERC20[] memory toks = new IERC20[](2);
        toks[0] = IERC20(vm.envOr("USDC", ArcMainnet.USDC));
        toks[1] = IERC20(vm.envOr("EURC", ArcMainnet.EURC));
        vm.startBroadcast();
        dc = new DocumentaryCredit(
            toks,
            IIdentityRegistry(vm.envOr("IDENTITY_REGISTRY", ArcMainnet.IDENTITY_REGISTRY)),
            IReputationRegistry(vm.envOr("REPUTATION_REGISTRY", ArcMainnet.REPUTATION_REGISTRY)),
            vm.envAddress("TREASURY"),
            uint16(vm.envOr("FEE_BPS", uint256(25)))
        );
        vm.stopBroadcast();
        console.log("DocumentaryCredit deployed at", address(dc));
    }
}
