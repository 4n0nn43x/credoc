// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {DocumentaryCredit, ICredocPass, IIdentityRegistry, IReputationRegistry} from "../src/DocumentaryCredit.sol";
import {CredocPass} from "../src/CredocPass.sol";
import {MockToken, MockRegistries} from "./Mocks.sol";

/// @dev Drives random sequences of every state-changing entry point.
contract Handler is Test {
    DocumentaryCredit public dc;
    MockToken public usdc;
    address[4] public actors;
    address public forwarder = makeAddr("fwd");
    address public inspector = makeAddr("insp");
    uint256[] public creditIds;
    uint256[] public offerIds;

    constructor(DocumentaryCredit _dc, MockToken _usdc) {
        dc = _dc;
        usdc = _usdc;
        for (uint256 i; i < 4; i++) {
            actors[i] = makeAddr(string.concat("actor", vm.toString(i)));
            usdc.mint(actors[i], 1e30);
            vm.prank(actors[i]);
            usdc.approve(address(dc), type(uint256).max);
        }
    }

    function _actor(uint256 s) internal view returns (address) {
        return actors[s % 4];
    }

    function _credit(uint256 s) internal view returns (uint256) {
        return creditIds.length == 0 ? 0 : creditIds[s % creditIds.length];
    }

    function open(uint256 a, uint256 b, uint128 x, uint128 y, uint8 masks) external {
        address app = _actor(a);
        address ben = _actor(b);
        if (app == ben) ben = _actor(a + 1);
        DocumentaryCredit.OpenParams memory p;
        p.beneficiary = ben;
        p.token = usdc;
        p.expiry = uint64(block.timestamp + 1 + (x % 60 days));
        p.docs = new DocumentaryCredit.DocRequirement[](2);
        p.docs[0] = DocumentaryCredit.DocRequirement(keccak256("BL"), forwarder);
        p.docs[1] = DocumentaryCredit.DocRequirement(keccak256("INSP"), inspector);
        p.tranches = new DocumentaryCredit.TrancheSpec[](2);
        p.tranches[0] = DocumentaryCredit.TrancheSpec(uint128(bound(x, 1, 1e15)), uint8(1 + masks % 3));
        p.tranches[1] = DocumentaryCredit.TrancheSpec(uint128(bound(y, 1, 1e15)), uint8(1 + (masks / 3) % 3));
        // half the credits come through the registered partner, with an integrator fee
        if (masks % 2 == 0) {
            p.partner = partner;
            p.integratorFeeBps = 50;
        }
        vm.prank(app);
        creditIds.push(dc.open(p, ""));
    }

    function present(uint256 c, uint8 tr, bool inspectorDoc) external {
        uint256 id = _credit(c);
        if (id == 0) return;
        vm.prank(inspectorDoc ? inspector : forwarder);
        try dc.present(id, tr % 2, inspectorDoc ? 1 : 0, keccak256(abi.encode(c, tr))) {} catch {}
    }

    function waive(uint256 c, uint8 tr, uint8 doc) external {
        uint256 id = _credit(c);
        if (id == 0) return;
        vm.prank(dc.getCredit(id).applicant);
        try dc.waive(id, tr % 2, doc % 2) {} catch {}
    }

    function warp(uint32 dt) external {
        vm.warp(block.timestamp + (dt % 20 days));
    }

    function reclaim(uint256 c) external {
        uint256 id = _credit(c);
        if (id == 0) return;
        try dc.reclaim(id) {} catch {}
    }

    function cancel(uint256 c) external {
        uint256 id = _credit(c);
        if (id == 0) return;
        vm.prank(dc.getCredit(id).payee);
        try dc.cancel(id) {} catch {}
    }

    function makeOffer(uint256 c, uint256 f, uint128 price) external {
        uint256 id = _credit(c);
        if (id == 0) return;
        DocumentaryCredit.Credit memory cr = dc.getCredit(id);
        if (cr.outstanding == 0) return;
        vm.prank(_actor(f));
        try dc.makeOffer(id, uint128(bound(price, 1, cr.outstanding)), cr.expiry) returns (uint256 o) {
            offerIds.push(o);
        } catch {}
    }

    function withdrawFees() external {
        try dc.withdrawFees(usdc) {} catch {}
    }

    function acceptOffer(uint256 o) external {
        if (offerIds.length == 0) return;
        uint256 off = offerIds[o % offerIds.length];
        (uint256 id,,,,,,) = dc.offers(off);
        vm.prank(dc.getCredit(id).payee);
        try dc.acceptOffer(off) {} catch {}
    }

    function withdrawOffer(uint256 o) external {
        if (offerIds.length == 0) return;
        uint256 off = offerIds[o % offerIds.length];
        (, address fin,,,,,) = dc.offers(off);
        vm.prank(fin);
        try dc.withdrawOffer(off) {} catch {}
    }

    function toggleBlock(uint256 a) external {
        address who = _actor(a);
        usdc.setBlocked(who, !usdc.blocked(who));
    }

    function withdrawOwed(uint256 a) external {
        vm.prank(_actor(a));
        try dc.withdrawOwed(usdc) {} catch {}
    }

    // ---- ghost accounting read by the invariant

    address public partner = makeAddr("partner");

    /// plans come and go at any time: discounts must never break solvency
    function togglePlan(uint256 a, uint8 plan, bool on) external {
        CredocPass ps = CredocPass(address(dc.pass()));
        vm.prank(ps.owner());
        ps.grant(_actor(a), uint8(2 + plan % 2), on ? uint64(block.timestamp + 30 days) : 0);
    }

    function withdrawPartner() external {
        vm.prank(partner);
        try dc.withdrawOwed(usdc) {} catch {}
    }

    function liabilities() external view returns (uint256 sum) {
        for (uint256 i; i < creditIds.length; i++) {
            DocumentaryCredit.Credit memory c = dc.getCredit(creditIds[i]);
            if (c.status == DocumentaryCredit.Status.Active) sum += c.outstanding;
        }
        for (uint256 i; i < offerIds.length; i++) {
            (,, uint128 price,,,, bool isOpen) = dc.offers(offerIds[i]);
            if (isOpen) sum += price;
        }
        for (uint256 i; i < 4; i++) {
            sum += dc.owed(actors[i], usdc);
        }
        sum += dc.fees(usdc);
        sum += dc.owed(partner, usdc);
    }

    function creditCount() external view returns (uint256) {
        return creditIds.length;
    }

    function creditAt(uint256 i) external view returns (uint256) {
        return creditIds[i];
    }
}

contract InvariantTest is Test {
    DocumentaryCredit dc;
    MockToken usdc;
    Handler h;

    function setUp() public {
        vm.warp(1_790_000_000);
        usdc = new MockToken("USDC");
        MockRegistries reg = new MockRegistries();
        IERC20[] memory toks = new IERC20[](1);
        toks[0] = usdc;
        dc = new DocumentaryCredit(toks, IIdentityRegistry(address(reg)), IReputationRegistry(address(reg)), makeAddr("treasury"), 25);
        h = new Handler(dc, usdc);
        CredocPass ps = new CredocPass(usdc, makeAddr("treasury"), [uint96(49e6), 99e6, 299e6]);
        dc.setPass(ICredocPass(address(ps)), 10);
        dc.setPartner(h.partner(), 2500, 50);
        targetContract(address(h));
    }

    /// every token held is owed to someone, and nothing owed is missing
    function invariant_solvency() public view {
        assertEq(usdc.balanceOf(address(dc)), h.liabilities());
    }

    /// a credit is either active with funds outstanding, or closed with nothing outstanding
    function invariant_statusConsistent() public view {
        for (uint256 i; i < h.creditCount(); i++) {
            DocumentaryCredit.Credit memory c = dc.getCredit(h.creditAt(i));
            if (c.status == DocumentaryCredit.Status.Closed) assertEq(c.outstanding, 0);
            else assertGt(c.outstanding, 0);
            assertLe(c.outstanding, c.total);
        }
    }
}
