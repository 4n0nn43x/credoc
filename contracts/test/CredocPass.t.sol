// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {CredocPass} from "../src/CredocPass.sol";
import {MockToken} from "./Mocks.sol";

contract CredocPassTest is Test {
    CredocPass pass;
    MockToken usdc;
    address treasury = makeAddr("treasury");
    address importer = makeAddr("importer");
    address forwarder = makeAddr("forwarder");

    function setUp() public {
        vm.warp(1_790_000_000);
        usdc = new MockToken("USDC");
        pass = new CredocPass(usdc, treasury, [uint96(49e6), 99e6, 299e6]);
        usdc.mint(importer, 10_000e6);
        vm.prank(importer);
        usdc.approve(address(pass), type(uint256).max);
    }

    function test_buy_paysTreasuryAndActivates() public {
        vm.prank(importer);
        uint64 until = pass.buy(importer, 2, 1); // IMPORTER
        assertEq(until, block.timestamp + 30 days);
        assertEq(usdc.balanceOf(treasury), 99e6);
        assertEq(usdc.balanceOf(address(pass)), 0, "never holds funds");
        assertTrue(pass.isActive(importer, 2));
        assertFalse(pass.isActive(importer, 3));
        vm.warp(until + 1);
        assertFalse(pass.isActive(importer, 2));
    }

    function test_buy_extendsFromCurrentEnd_andYearIsTenMonths() public {
        vm.startPrank(importer);
        pass.buy(importer, 2, 1);
        uint64 until = pass.buy(importer, 2, 12);
        vm.stopPrank();
        assertEq(until, block.timestamp + 13 * 30 days);
        assertEq(usdc.balanceOf(treasury), 99e6 + 10 * 99e6);
    }

    function test_buy_forSomeoneElse() public {
        vm.prank(importer); // an importer sponsors its forwarder's attestor plan
        pass.buy(forwarder, 1, 1); // ATTESTOR
        assertTrue(pass.isActive(forwarder, 1));
        assertFalse(pass.isActive(importer, 1));
    }

    function test_buy_rejectsBadInput() public {
        vm.startPrank(importer);
        vm.expectRevert(CredocPass.BadParams.selector);
        pass.buy(importer, 0, 1);
        vm.expectRevert(CredocPass.BadParams.selector);
        pass.buy(importer, 4, 1);
        vm.expectRevert(CredocPass.BadParams.selector);
        pass.buy(importer, 1, 0);
        vm.expectRevert(CredocPass.BadParams.selector);
        pass.buy(importer, 1, 37);
        vm.expectRevert(CredocPass.BadParams.selector);
        pass.buy(address(0), 1, 1);
        vm.stopPrank();
        pass.setPrice(1, 0);
        vm.prank(importer);
        vm.expectRevert(CredocPass.NotForSale.selector);
        pass.buy(importer, 1, 1);
    }

    function test_owner_grantsPricesAndBadges() public {
        pass.grant(forwarder, 1, uint64(block.timestamp + 90 days));
        assertTrue(pass.isActive(forwarder, 1));
        pass.setVerified(forwarder, true);
        assertTrue(pass.verified(forwarder));
        pass.setPrice(2, 79e6);
        assertEq(pass.quote(2, 2), 158e6);
        vm.startPrank(importer);
        vm.expectRevert();
        pass.grant(importer, 2, type(uint64).max);
        vm.expectRevert();
        pass.setVerified(importer, true);
        vm.expectRevert();
        pass.setPrice(2, 0);
        vm.stopPrank();
    }
}
