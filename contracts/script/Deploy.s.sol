// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {DocumentaryCredit, ICredocPass, IIdentityRegistry, IReputationRegistry} from "../src/DocumentaryCredit.sol";
import {CredocPass} from "../src/CredocPass.sol";
import {ArcMainnet} from "./ArcMainnet.sol";

/// Mainnet:
///   TREASURY=0x... arc-forge script script/Deploy.s.sol --rpc-url arc --account <keystore> --broadcast
/// The deployer becomes the owner of both contracts (fees, plans, partners, treasury). FEE_BPS defaults to 25 (0.25%),
/// PRO_FEE_BPS (plan holders) to 10. Plans cost 49 / 99 / 299 USDC per 30 days (attestor / importer / financier).
/// The same addresses exist on Arc testnet for the ERC-8004 registries; pass USDC/EURC through env to override.
contract Deploy is Script {
    function run() external returns (DocumentaryCredit dc, CredocPass pass) {
        address treasury = vm.envAddress("TREASURY");
        IERC20[] memory toks = new IERC20[](2);
        toks[0] = IERC20(vm.envOr("USDC", ArcMainnet.USDC));
        toks[1] = IERC20(vm.envOr("EURC", ArcMainnet.EURC));
        vm.startBroadcast();
        dc = new DocumentaryCredit(
            toks,
            IIdentityRegistry(vm.envOr("IDENTITY_REGISTRY", ArcMainnet.IDENTITY_REGISTRY)),
            IReputationRegistry(vm.envOr("REPUTATION_REGISTRY", ArcMainnet.REPUTATION_REGISTRY)),
            treasury,
            uint16(vm.envOr("FEE_BPS", uint256(25)))
        );
        pass = new CredocPass(toks[0], treasury, [uint96(49e6), 99e6, 299e6]);
        dc.setPass(ICredocPass(address(pass)), uint16(vm.envOr("PRO_FEE_BPS", uint256(10))));
        vm.stopBroadcast();
        console.log("DocumentaryCredit deployed at", address(dc));
        console.log("CredocPass deployed at", address(pass));
    }
}
