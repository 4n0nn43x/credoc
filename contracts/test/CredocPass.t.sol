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

    /// review 2026-10-17 (L-5): a grant can end a free plan, but never shorten a paid one
    function test_grant_cannotShortenAPaidPlan() public {
        pass.grant(forwarder, 1, uint64(block.timestamp + 90 days));
        pass.grant(forwarder, 1, 0); // a pilot ends
        assertFalse(pass.isActive(forwarder, 1));
        vm.prank(importer);
        uint64 until = pass.buy(importer, 2, 1);
        vm.expectRevert(CredocPass.BadParams.selector);
        pass.grant(importer, 2, 0);
        vm.expectRevert(CredocPass.BadParams.selector);
        pass.grant(importer, 2, until - 1);
        pass.grant(importer, 2, until + 30 days); // extending stays possible
        pass.grant(importer, 2, until); // and so does taking the gift back
        assertEq(pass.activeUntil(importer, 2), until);
    }

    /// review 2026-10-17: a month bought on top of a gifted year protects that month, not the gift
    function test_grant_canStillEndAGiftBelowAPurchase() public {
        pass.grant(importer, 2, uint64(block.timestamp + 365 days));
        vm.prank(importer);
        pass.buy(importer, 2, 1);
        uint64 paid = uint64(block.timestamp + 30 days);
        assertEq(pass.paidUntil(importer, 2), paid);
        vm.expectRevert(CredocPass.BadParams.selector);
        pass.grant(importer, 2, paid - 1);
        pass.grant(importer, 2, paid); // the gift is taken back, the paid month stays
        assertTrue(pass.isActive(importer, 2));
    }

    /// review 2026-10-13 (L-2): buying on top of a far-future grant reverts instead of wrapping to 1970
    function test_buy_cannotWrapAGrant() public {
        pass.grant(importer, 2, type(uint64).max);
        vm.prank(importer);
        vm.expectRevert(CredocPass.BadParams.selector);
        pass.buy(importer, 2, 1);
        assertTrue(pass.isActive(importer, 2));
    }
}
