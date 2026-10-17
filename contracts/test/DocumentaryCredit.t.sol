// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {DocumentaryCredit, ICredocPass, IIdentityRegistry, IReputationRegistry} from "../src/DocumentaryCredit.sol";
import {MockToken, MockRegistries, ReturnBombRegistry} from "./Mocks.sol";
import {CredocPass} from "../src/CredocPass.sol";

/// @dev minimal ERC-1271 smart wallet, to prove contract-wallet attestors work
contract Wallet1271 {
    address immutable owner;

    constructor(address o) {
        owner = o;
    }

    function isValidSignature(bytes32 h, bytes calldata sig) external view returns (bytes4) {
        return ECDSA.recover(h, sig) == owner ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}

contract DocumentaryCreditTest is Test {
    DocumentaryCredit dc;
    MockToken usdc;
    MockToken eurc;
    MockToken other;
    MockRegistries reg;

    address importer = makeAddr("importer");
    address exporter = makeAddr("exporter");
    address financier = makeAddr("financier");
    address financier2 = makeAddr("financier2");
    address stranger = makeAddr("stranger");
    uint256 forwarderKey = 0xF0;
    uint256 inspectorKey = 0x15;
    address forwarder;
    address inspector;

    bytes32 constant BL = keccak256("BILL_OF_LADING");
    bytes32 constant INSP = keccak256("INSPECTION_CERTIFICATE");
    uint64 expiry;

    function setUp() public {
        vm.warp(1_790_000_000);
        forwarder = vm.addr(forwarderKey);
        inspector = vm.addr(inspectorKey);
        usdc = new MockToken("USDC");
        eurc = new MockToken("EURC");
        other = new MockToken("OTHER");
        reg = new MockRegistries();
        IERC20[] memory toks = new IERC20[](2);
        toks[0] = usdc;
        toks[1] = eurc;
        dc = new DocumentaryCredit(toks, IIdentityRegistry(address(reg)), IReputationRegistry(address(reg)), address(this), 0);
        expiry = uint64(block.timestamp + 30 days);

        for (uint256 i; i < 3; i++) {
            address a = i == 0 ? importer : i == 1 ? financier : financier2;
            usdc.mint(a, 1_000_000e6);
            eurc.mint(a, 1_000_000e6);
            vm.startPrank(a);
            usdc.approve(address(dc), type(uint256).max);
            eurc.approve(address(dc), type(uint256).max);
            vm.stopPrank();
        }
        reg.setOwner(1, importer);
        reg.setOwner(2, exporter);
        reg.setOwner(3, stranger);
    }

    // ------------------------------------------------------------ helpers

    /// two documents (BL by forwarder, inspection by inspector); tranche 0 needs both, tranche 1 needs BL only
    function _params(uint128 a0, uint128 a1) internal view returns (DocumentaryCredit.OpenParams memory p) {
        p.beneficiary = exporter;
        p.token = usdc;
        p.expiry = expiry;
        p.terms = keccak256("PO-2026-001");
        p.docs = new DocumentaryCredit.DocRequirement[](2);
        p.docs[0] = DocumentaryCredit.DocRequirement(BL, forwarder);
        p.docs[1] = DocumentaryCredit.DocRequirement(INSP, inspector);
        p.tranches = new DocumentaryCredit.TrancheSpec[](a1 == 0 ? 1 : 2);
        p.tranches[0] = DocumentaryCredit.TrancheSpec(a0, 3);
        if (a1 != 0) p.tranches[1] = DocumentaryCredit.TrancheSpec(a1, 1);
    }

    function _open(uint128 a0, uint128 a1) internal returns (uint256) {
        vm.prank(importer);
        return dc.open(_params(a0, a1), "PO-2026-001");
    }

    function _sig(uint256 key, uint256 id, uint8 tr, uint8 doc, bytes32 h, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, dc.presentationDigest(id, tr, doc, h, deadline));
        return abi.encodePacked(r, s, v);
    }

    function _presentBoth(uint256 id, uint8 tr) internal {
        vm.prank(forwarder);
        dc.present(id, tr, 0, keccak256("bl"));
        vm.prank(inspector);
        dc.present(id, tr, 1, keccak256("insp"));
    }

    // ------------------------------------------------------------ open

    function test_open_locksFunds() public {
        uint256 id = _open(6000e6, 4000e6);
        assertEq(id, 1);
        assertEq(usdc.balanceOf(address(dc)), 10_000e6);
        DocumentaryCredit.Credit memory c = dc.getCredit(id);
        assertEq(c.applicant, importer);
        assertEq(c.payee, exporter);
        assertEq(c.total, 10_000e6);
        assertEq(c.outstanding, 10_000e6);
        assertEq(uint8(c.status), uint8(DocumentaryCredit.Status.Active));
        assertEq(dc.getTranches(id).length, 2);
        assertEq(dc.getDocs(id)[1].attestor, inspector);
    }

    function test_open_eurc() public {
        DocumentaryCredit.OpenParams memory p = _params(500e6, 0);
        p.token = eurc;
        vm.prank(importer);
        dc.open(p, "");
        assertEq(eurc.balanceOf(address(dc)), 500e6);
    }

    function test_open_rejectsBadParams() public {
        DocumentaryCredit.OpenParams memory p;

        p = _params(1e6, 0);
        p.token = other;
        vm.prank(importer);
        vm.expectRevert(DocumentaryCredit.TokenNotAllowed.selector);
        dc.open(p, "");

        p = _params(1e6, 0);
        p.beneficiary = importer;
        _expectBad(p);
        p.beneficiary = address(0);
        _expectBad(p);

        p = _params(1e6, 0);
        p.expiry = uint64(block.timestamp);
        _expectBad(p);
        p.expiry = uint64(block.timestamp + 731 days);
        _expectBad(p);

        p = _params(1e6, 0);
        p.tranches[0].amount = 0;
        _expectBad(p);

        p = _params(1e6, 0);
        p.tranches[0].requiredDocs = 0;
        _expectBad(p);
        p.tranches[0].requiredDocs = 4; // doc index 2 does not exist
        _expectBad(p);

        p = _params(1e6, 0);
        p.docs[0].attestor = exporter; // exporter cannot attest its own shipment
        _expectBad(p);
        p.docs[0].attestor = importer;
        _expectBad(p);
        p.docs[0].attestor = address(0);
        _expectBad(p);

        p = _params(1e6, 0);
        p.docs = new DocumentaryCredit.DocRequirement[](9);
        _expectBad(p);

        p = _params(uint128(uint256(uint128(type(int128).max))), 1);
        _expectBad(p);
    }

    function _expectBad(DocumentaryCredit.OpenParams memory p) internal {
        vm.prank(importer);
        vm.expectRevert(DocumentaryCredit.BadParams.selector);
        dc.open(p, "");
    }

    function test_open_applicantAgentMustBeOwned() public {
        DocumentaryCredit.OpenParams memory p = _params(1e6, 0);
        p.applicantAgent = 3 + 1; // agent 3 belongs to stranger
        vm.prank(importer);
        vm.expectRevert(DocumentaryCredit.Unauthorized.selector);
        dc.open(p, "");
    }

    // ------------------------------------------------------------ presentation and settlement

    function test_settlesWhenAllDocsPresented() public {
        uint256 id = _open(6000e6, 4000e6);
        vm.prank(forwarder);
        dc.present(id, 0, 0, keccak256("bl"));
        assertEq(usdc.balanceOf(exporter), 0, "one doc missing");
        vm.prank(inspector);
        dc.present(id, 0, 1, keccak256("insp"));
        assertEq(usdc.balanceOf(exporter), 6000e6);
        assertEq(dc.getCredit(id).outstanding, 4000e6);
        assertEq(dc.presentedHash(id, 1), keccak256("insp"));

        vm.prank(forwarder);
        dc.present(id, 1, 0, keccak256("bl2"));
        assertEq(usdc.balanceOf(exporter), 10_000e6);
        assertEq(usdc.balanceOf(address(dc)), 0);
        assertEq(uint8(dc.getCredit(id).status), uint8(DocumentaryCredit.Status.Closed));
    }

    function test_present_rejects() public {
        uint256 id = _open(6000e6, 4000e6);

        vm.prank(stranger);
        vm.expectRevert(DocumentaryCredit.Unauthorized.selector);
        dc.present(id, 0, 0, keccak256("bl"));

        vm.prank(inspector); // inspector nominated for doc 1, not doc 0
        vm.expectRevert(DocumentaryCredit.Unauthorized.selector);
        dc.present(id, 0, 0, keccak256("bl"));

        vm.prank(inspector); // tranche 1 does not require the inspection
        vm.expectRevert(DocumentaryCredit.NotRequired.selector);
        dc.present(id, 1, 1, keccak256("insp"));

        vm.prank(forwarder);
        vm.expectRevert(DocumentaryCredit.BadParams.selector);
        dc.present(id, 0, 0, bytes32(0));

        vm.prank(forwarder);
        vm.expectRevert(DocumentaryCredit.BadParams.selector);
        dc.present(id, 5, 0, keccak256("bl"));

        vm.prank(forwarder);
        vm.expectRevert(DocumentaryCredit.BadParams.selector);
        dc.present(id, 0, 7, keccak256("bl"));

        vm.prank(forwarder);
        dc.present(id, 0, 0, keccak256("bl"));
        vm.prank(forwarder);
        vm.expectRevert(DocumentaryCredit.AlreadySatisfied.selector);
        dc.present(id, 0, 0, keccak256("bl-again"));

        vm.warp(expiry + 1);
        vm.prank(inspector);
        vm.expectRevert(DocumentaryCredit.Expired.selector);
        dc.present(id, 0, 1, keccak256("insp"));

        vm.prank(forwarder);
        vm.expectRevert(DocumentaryCredit.NotActive.selector);
        dc.present(99, 0, 0, keccak256("bl"));
    }

    function test_presentWithSig_relayedByAnyone() public {
        uint256 id = _open(1000e6, 0);
        uint256 dl = block.timestamp + 1 hours;
        bytes memory s0 = _sig(forwarderKey, id, 0, 0, keccak256("bl"), dl);
        bytes memory s1 = _sig(inspectorKey, id, 0, 1, keccak256("insp"), dl);
        vm.startPrank(stranger); // the relayer pays the gas, attestors never touch USDC
        dc.presentWithSig(id, 0, 0, keccak256("bl"), dl, s0);
        dc.presentWithSig(id, 0, 1, keccak256("insp"), dl, s1);
        vm.stopPrank();
        assertEq(usdc.balanceOf(exporter), 1000e6);
    }

    function test_presentWithSig_rejects() public {
        uint256 id = _open(1000e6, 1000e6);
        uint256 dl = block.timestamp + 1 hours;

        bytes memory wrongSigner = _sig(inspectorKey, id, 0, 0, keccak256("bl"), dl);
        vm.expectRevert(DocumentaryCredit.BadSignature.selector);
        dc.presentWithSig(id, 0, 0, keccak256("bl"), dl, wrongSigner);

        bytes memory good = _sig(forwarderKey, id, 0, 0, keccak256("bl"), dl);
        vm.expectRevert(DocumentaryCredit.BadSignature.selector); // different hash than signed
        dc.presentWithSig(id, 0, 0, keccak256("forged"), dl, good);
        vm.expectRevert(DocumentaryCredit.BadSignature.selector); // replay on another tranche
        dc.presentWithSig(id, 1, 0, keccak256("bl"), dl, good);

        dc.presentWithSig(id, 0, 0, keccak256("bl"), dl, good);
        vm.expectRevert(DocumentaryCredit.AlreadySatisfied.selector); // replay
        dc.presentWithSig(id, 0, 0, keccak256("bl"), dl, good);

        vm.warp(dl + 1);
        bytes memory late = _sig(inspectorKey, id, 0, 1, keccak256("insp"), dl);
        vm.expectRevert(DocumentaryCredit.SignatureExpired.selector);
        dc.presentWithSig(id, 0, 1, keccak256("insp"), dl, late);
    }

    function test_presentWithSig_erc1271Wallet() public {
        Wallet1271 w = new Wallet1271(forwarder);
        DocumentaryCredit.OpenParams memory p = _params(1000e6, 0);
        p.docs[0].attestor = address(w);
        p.tranches[0].requiredDocs = 1;
        vm.prank(importer);
        uint256 id = dc.open(p, "");
        uint256 dl = block.timestamp + 1 hours;
        dc.presentWithSig(id, 0, 0, keccak256("bl"), dl, _sig(forwarderKey, id, 0, 0, keccak256("bl"), dl));
        assertEq(usdc.balanceOf(exporter), 1000e6);
    }

    function test_waive_onlyApplicant_andSettles() public {
        uint256 id = _open(1000e6, 0);
        vm.prank(forwarder);
        dc.present(id, 0, 0, keccak256("bl"));
        vm.prank(exporter);
        vm.expectRevert(DocumentaryCredit.Unauthorized.selector);
        dc.waive(id, 0, 1);
        vm.prank(importer);
        dc.waive(id, 0, 1); // inspection certificate late, importer accepts the discrepancy
        assertEq(usdc.balanceOf(exporter), 1000e6);
        assertEq(dc.presentedHash(id, 1), bytes32(0));
    }

    // ------------------------------------------------------------ expiry, cancellation, amendment

    function test_reclaim_refundsOnlyUnsettled() public {
        uint256 id = _open(6000e6, 4000e6);
        _presentBoth(id, 0);
        vm.expectRevert(DocumentaryCredit.NotExpired.selector);
        dc.reclaim(id);
        vm.warp(expiry + 1);
        uint256 before = usdc.balanceOf(importer);
        vm.prank(stranger); // keepers can close expired credits
        dc.reclaim(id);
        assertEq(usdc.balanceOf(importer) - before, 4000e6);
        assertEq(usdc.balanceOf(exporter), 6000e6);
        assertEq(usdc.balanceOf(address(dc)), 0);
        vm.expectRevert(DocumentaryCredit.NotActive.selector);
        dc.reclaim(id);
    }

    function test_cancel_onlyPayee() public {
        uint256 id = _open(1000e6, 0);
        vm.prank(importer); // irrevocable: the applicant alone cannot cancel
        vm.expectRevert(DocumentaryCredit.Unauthorized.selector);
        dc.cancel(id);
        vm.prank(exporter);
        dc.cancel(id);
        assertEq(usdc.balanceOf(importer), 1_000_000e6);
        assertEq(uint8(dc.getCredit(id).status), uint8(DocumentaryCredit.Status.Closed));
    }

    function test_amendExpiry_needsBothSides() public {
        uint256 id = _open(1000e6, 0);
        uint64 later = expiry + 15 days;
        vm.prank(stranger);
        vm.expectRevert(DocumentaryCredit.Unauthorized.selector);
        dc.amendExpiry(id, later);

        vm.prank(importer);
        dc.amendExpiry(id, later);
        vm.prank(importer); // proposing twice yourself changes nothing
        dc.amendExpiry(id, later);
        assertEq(dc.getCredit(id).expiry, expiry);

        vm.prank(exporter); // counter-proposal with another date does not amend
        dc.amendExpiry(id, later + 1);
        assertEq(dc.getCredit(id).expiry, expiry);

        vm.prank(importer); // importer accepts the exporter's date
        dc.amendExpiry(id, later + 1);
        assertEq(dc.getCredit(id).expiry, later + 1);

        vm.warp(expiry + 1); // old expiry passed, presentation still valid
        _presentBoth(id, 0);
        assertEq(usdc.balanceOf(exporter), 1000e6);

        vm.prank(importer);
        vm.expectRevert(DocumentaryCredit.NotActive.selector);
        dc.amendExpiry(id, later + 2);
    }

    // ------------------------------------------------------------ forfaiting

    function test_forfaiting_financierGetsProceeds() public {
        uint256 id = _open(6000e6, 4000e6);
        vm.prank(financier);
        uint256 off = dc.makeOffer(id, 9500e6, uint64(block.timestamp + 1 days));
        assertEq(usdc.balanceOf(address(dc)), 19_500e6);

        vm.prank(stranger);
        vm.expectRevert(DocumentaryCredit.Unauthorized.selector);
        dc.acceptOffer(off);

        vm.prank(exporter);
        dc.acceptOffer(off);
        assertEq(usdc.balanceOf(exporter), 9500e6, "exporter paid before shipping");
        assertEq(dc.getCredit(id).payee, financier);

        uint256 fBefore = usdc.balanceOf(financier);
        _presentBoth(id, 0);
        vm.prank(forwarder);
        dc.present(id, 1, 0, keccak256("bl2"));
        assertEq(usdc.balanceOf(financier) - fBefore, 10_000e6, "financier collects at face value");
        assertEq(usdc.balanceOf(address(dc)), 0);
    }

    function test_forfaiting_resale_and_staleOffer() public {
        uint256 id = _open(6000e6, 4000e6);
        vm.prank(financier);
        uint256 o1 = dc.makeOffer(id, 9000e6, uint64(block.timestamp + 1 days));
        vm.prank(financier2);
        uint256 o2 = dc.makeOffer(id, 9600e6, uint64(block.timestamp + 1 days));

        vm.prank(exporter);
        dc.acceptOffer(o1);

        _presentBoth(id, 0); // financier collects 6000, outstanding drops to 4000
        vm.prank(financier);
        vm.expectRevert(DocumentaryCredit.StaleOffer.selector); // o2 priced the full 10000
        dc.acceptOffer(o2);

        vm.prank(financier2);
        dc.withdrawOffer(o2);
        vm.prank(financier2);
        uint256 o3 = dc.makeOffer(id, 3900e6, uint64(block.timestamp + 1 days));
        vm.prank(financier); // secondary market: financier sells the rest on
        dc.acceptOffer(o3);
        assertEq(dc.getCredit(id).payee, financier2);
    }

    function test_offer_rules() public {
        uint256 id = _open(1000e6, 0);
        vm.startPrank(financier);
        vm.expectRevert(DocumentaryCredit.BadParams.selector);
        dc.makeOffer(id, 1001e6, uint64(block.timestamp + 1));
        vm.expectRevert(DocumentaryCredit.BadParams.selector);
        dc.makeOffer(id, 0, uint64(block.timestamp + 1));
        vm.expectRevert(DocumentaryCredit.BadParams.selector);
        dc.makeOffer(id, 900e6, uint64(block.timestamp));
        uint256 off = dc.makeOffer(id, 900e6, uint64(block.timestamp + 1 hours));
        vm.stopPrank();

        vm.prank(stranger);
        vm.expectRevert(DocumentaryCredit.OfferUnavailable.selector);
        dc.withdrawOffer(off);

        vm.warp(block.timestamp + 2 hours);
        vm.prank(exporter);
        vm.expectRevert(DocumentaryCredit.OfferUnavailable.selector);
        dc.acceptOffer(off);

        uint256 b = usdc.balanceOf(financier);
        vm.prank(financier);
        dc.withdrawOffer(off);
        assertEq(usdc.balanceOf(financier) - b, 900e6);
        vm.prank(financier);
        vm.expectRevert(DocumentaryCredit.OfferUnavailable.selector);
        dc.withdrawOffer(off);
    }

    function test_offer_withdrawableAfterCreditClosed() public {
        uint256 id = _open(1000e6, 0);
        vm.prank(financier);
        uint256 off = dc.makeOffer(id, 900e6, uint64(block.timestamp + 1 days));
        _presentBoth(id, 0);
        vm.prank(exporter);
        vm.expectRevert(DocumentaryCredit.NotActive.selector);
        dc.acceptOffer(off);
        vm.prank(financier);
        dc.withdrawOffer(off);
        assertEq(usdc.balanceOf(address(dc)), 0);
    }

    function test_acceptOffer_clearsSellerExpiryProposal() public {
        uint256 id = _open(1000e6, 0);
        vm.prank(exporter);
        dc.amendExpiry(id, expiry + 10 days);
        vm.prank(financier);
        uint256 off = dc.makeOffer(id, 900e6, uint64(block.timestamp + 1 days));
        vm.prank(exporter);
        dc.acceptOffer(off);
        vm.prank(importer); // would have matched the old payee's proposal
        dc.amendExpiry(id, expiry + 10 days);
        assertEq(dc.getCredit(id).expiry, expiry, "new payee must consent itself");
        vm.prank(financier);
        dc.amendExpiry(id, expiry + 10 days);
        assertEq(dc.getCredit(id).expiry, expiry + 10 days);
    }

    // ------------------------------------------------------------ blocklist resilience

    function test_blockedPayee_doesNotBlockSettlement() public {
        uint256 id = _open(1000e6, 0);
        usdc.setBlocked(exporter, true);
        _presentBoth(id, 0); // must not revert
        assertEq(dc.owed(exporter, usdc), 1000e6);
        assertEq(uint8(dc.getCredit(id).status), uint8(DocumentaryCredit.Status.Closed));

        vm.prank(exporter);
        vm.expectRevert(); // still blocked
        dc.withdrawOwed(usdc);

        usdc.setBlocked(exporter, false);
        vm.prank(exporter);
        dc.withdrawOwed(usdc);
        assertEq(usdc.balanceOf(exporter), 1000e6);
        vm.prank(exporter);
        vm.expectRevert(DocumentaryCredit.NothingOwed.selector);
        dc.withdrawOwed(usdc);
    }

    // ------------------------------------------------------------ ERC-8004 reputation

    function test_reputation_writtenOnSettlementAndExpiry() public {
        DocumentaryCredit.OpenParams memory p = _params(6000e6, 4000e6);
        p.applicantAgent = 1 + 1;
        vm.prank(importer);
        uint256 id = dc.open(p, "");

        vm.prank(stranger);
        vm.expectRevert(DocumentaryCredit.Unauthorized.selector);
        dc.linkAgent(2);
        vm.prank(exporter);
        vm.expectRevert(DocumentaryCredit.Unauthorized.selector);
        dc.linkAgent(3); // not its agent
        vm.prank(exporter);
        dc.linkAgent(2);

        _presentBoth(id, 0);
        assertEq(reg.count(), 3);
        (uint256 agent, address client, int128 value,, string memory t1, string memory t2, string memory uri) =
            reg.feedbacks(0);
        assertEq(agent, 2);
        assertEq(client, address(dc));
        assertEq(value, 100);
        assertEq(t1, "credoc");
        assertEq(t2, "delivered");
        assertEq(uri, string.concat("credoc:31337:", vm.toLowercase(vm.toString(address(dc))), ":1"));
        uint8 dec;
        (agent,, value, dec,, t2,) = reg.feedbacks(1);
        assertEq(value, 6000e6);
        assertEq(dec, 6);
        assertEq(t2, "volume-USDC");
        (agent,,,,,,) = reg.feedbacks(2);
        assertEq(agent, 1, "importer volume");

        vm.warp(expiry + 1);
        dc.reclaim(id);
        (agent,, value,,, t2,) = reg.feedbacks(3);
        assertEq(agent, 2);
        assertEq(value, 0);
        assertEq(t2, "expired");
    }

    function test_reputation_failureNeverBlocksMoney() public {
        uint256 id = _open(1000e6, 0);
        vm.prank(exporter);
        dc.linkAgent(2);
        reg.setBroken(true);
        vm.prank(forwarder);
        dc.present(id, 0, 0, keccak256("bl"));
        vm.recordLogs();
        vm.prank(inspector); // this presentation triggers the payment and the feedback attempts
        dc.present(id, 0, 1, keccak256("insp"));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 skipped;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].topics[0] == DocumentaryCredit.ReputationSkipped.selector) skipped++;
        }
        assertEq(skipped, 2, "delivered and volume feedbacks skipped");
        assertEq(usdc.balanceOf(exporter), 1000e6);
    }

    function test_worksWithoutRegistries() public {
        IERC20[] memory toks = new IERC20[](1);
        toks[0] = usdc;
        DocumentaryCredit bare =
            new DocumentaryCredit(toks, IIdentityRegistry(address(0)), IReputationRegistry(address(0)), address(this), 0);
        vm.startPrank(importer);
        usdc.approve(address(bare), type(uint256).max);
        DocumentaryCredit.OpenParams memory p = _params(1000e6, 0);
        p.applicantAgent = 2; // cannot be checked without a registry
        vm.expectRevert(DocumentaryCredit.Unauthorized.selector);
        bare.open(p, "");
        p.applicantAgent = 0;
        uint256 id = bare.open(p, "");
        vm.stopPrank();
        vm.prank(forwarder);
        bare.present(id, 0, 0, keccak256("bl"));
        vm.prank(inspector);
        bare.present(id, 0, 1, keccak256("insp"));
        assertEq(usdc.balanceOf(exporter), 1000e6);
    }

    // ------------------------------------------------------------ fuzz

    function testFuzz_conservation(uint128 a0, uint128 a1, bool settleFirst, bool assign, uint128 price) public {
        a0 = uint128(bound(a0, 1, 400_000e6));
        a1 = uint128(bound(a1, 1, 400_000e6));
        uint256 id = _open(a0, a1);
        uint256 total = uint256(a0) + a1;
        uint256 paidToSeller;
        if (assign) {
            price = uint128(bound(price, 1, total));
            vm.prank(financier);
            uint256 off = dc.makeOffer(id, price, uint64(block.timestamp + 1 days));
            vm.prank(exporter);
            dc.acceptOffer(off);
            paidToSeller = price;
        }
        address payee = dc.getCredit(id).payee;
        uint256 payeeBefore = usdc.balanceOf(payee);
        if (settleFirst) _presentBoth(id, 0);
        vm.warp(expiry + 1);
        uint256 impBefore = usdc.balanceOf(importer);
        dc.reclaim(id);
        uint256 settled = settleFirst ? a0 : 0;
        assertEq(usdc.balanceOf(payee) - payeeBefore, settled);
        assertEq(usdc.balanceOf(importer) - impBefore, total - settled);
        assertEq(usdc.balanceOf(exporter), paidToSeller + (assign ? 0 : settled));
        assertEq(usdc.balanceOf(address(dc)), 0);
    }

    // ------------------------------------------------------------ regressions from the security review

    /// H-1: parties could shorten expiry right before selling, then let it lapse and keep the financier's price
    function test_review_H1_expiryCannotBeShortened() public {
        uint256 id = _open(1000e6, 0);
        vm.prank(importer);
        vm.expectRevert(DocumentaryCredit.BadParams.selector);
        dc.amendExpiry(id, uint64(block.timestamp + 1));
        vm.prank(exporter);
        vm.expectRevert(DocumentaryCredit.BadParams.selector);
        dc.amendExpiry(id, expiry);
    }

    /// L-1: a stale proposal could be accepted after expiry and revive a lapsed credit
    function test_review_L1_noAmendmentAfterExpiry() public {
        uint256 id = _open(1000e6, 0);
        vm.prank(importer);
        dc.amendExpiry(id, expiry + 10 days);
        vm.warp(expiry + 1);
        vm.prank(exporter);
        vm.expectRevert(DocumentaryCredit.Expired.selector);
        dc.amendExpiry(id, expiry + 10 days);
    }

    /// M-1: a registry burning all gas must not make settlement impossible
    function test_review_M1_gasBurningRegistryCannotBlockSettlement() public {
        DocumentaryCredit.OpenParams memory p = _params(1000e6, 0);
        p.applicantAgent = 1 + 1;
        vm.prank(importer);
        uint256 id = dc.open(p, "");
        vm.prank(exporter);
        dc.linkAgent(2);
        reg.setBurn(true);
        vm.prank(forwarder);
        dc.present(id, 0, 0, keccak256("bl"));
        vm.prank(inspector);
        uint256 g = gasleft();
        dc.present{gas: 2_000_000}(id, 0, 1, keccak256("insp"));
        assertLt(g - gasleft(), 2_000_000);
        assertEq(usdc.balanceOf(exporter), 1000e6);
    }

    /// M-1 / I-1: starving the feedback call on purpose reverts instead of silently skipping the entry
    function test_review_M1_cannotSkipFeedbackByStarvingGas() public {
        uint256 id = _open(1000e6, 0);
        vm.prank(exporter);
        dc.linkAgent(2);
        vm.warp(expiry + 1);
        vm.expectRevert(DocumentaryCredit.InsufficientGas.selector);
        dc.reclaim{gas: 200_000}(id);
        dc.reclaim(id);
        (,,,,, string memory t2,) = reg.feedbacks(0);
        assertEq(t2, "expired");
    }

    /// M-2: the beneficiary cannot swap to a throwaway identity before expiry
    function test_review_M2_agentLinkedOnce() public {
        uint256 id = _open(1000e6, 0);
        reg.setOwner(9, exporter);
        vm.startPrank(exporter);
        dc.linkAgent(2);
        vm.expectRevert(DocumentaryCredit.AlreadyLinked.selector);
        dc.linkAgent(9);
        vm.stopPrank();
    }

    /// M-2 / L-4: cancel is recorded, and negative entries are written per tranche
    function test_review_M2_cancelRecordedPerTranche() public {
        uint256 id = _open(600e6, 400e6);
        vm.prank(exporter);
        dc.linkAgent(2);
        vm.prank(exporter);
        dc.cancel(id);
        assertEq(reg.count(), 2);
        (,,,,, string memory t2,) = reg.feedbacks(1);
        assertEq(t2, "cancelled");
    }

    /// M-2: a tranche settled only through applicant waivers is not counted as a delivery
    function test_review_M2_waivedSettlementTaggedApart() public {
        uint256 id = _open(1000e6, 0);
        vm.prank(exporter);
        dc.linkAgent(2);
        vm.prank(forwarder);
        dc.present(id, 0, 0, keccak256("bl"));
        vm.prank(importer);
        dc.waive(id, 0, 1);
        (,,,,, string memory t2,) = reg.feedbacks(0);
        assertEq(t2, "waived");
        assertEq(dc.getTranches(id)[0].waivedDocs, 2);
    }

    /// L-2: a blocklisted payee cannot sell its proceeds
    function test_review_L2_blockedPayeeCannotSell() public {
        uint256 id = _open(1000e6, 0);
        vm.prank(financier);
        uint256 off = dc.makeOffer(id, 900e6, uint64(block.timestamp + 1 days));
        usdc.setBlocked(exporter, true);
        vm.prank(exporter);
        vm.expectRevert();
        dc.acceptOffer(off);
        assertEq(dc.getCredit(id).payee, exporter);
    }

    /// L-3: euro volume is never averaged with dollar volume
    function test_review_L3_volumeTagPerToken() public {
        assertEq(dc.volumeTag(usdc), "volume-USDC");
        assertEq(dc.volumeTag(eurc), "volume-EURC");
    }

    function test_review_beneficiaryCannotBeTheContract() public {
        DocumentaryCredit.OpenParams memory p = _params(1e6, 0);
        p.beneficiary = address(dc);
        _expectBad(p);
    }

    // ------------------------------------------------------------ review 2026-10-17

    /// M-1: the importer could buy the proceeds, become payee, cancel and take its money back
    function test_review3_M1_applicantCannotBuyItsProceeds() public {
        uint256 id = _open(1000e6, 0);
        vm.prank(importer);
        vm.expectRevert(DocumentaryCredit.Unauthorized.selector);
        dc.makeOffer(id, 900e6, uint64(block.timestamp + 1 days));
        assertEq(dc.offerCount(), 0);
    }

    /// M-1: a cancel decided by a financier who bought the proceeds is not written as the exporter's "cancelled"
    function test_review3_M1_assigneeCancelTaggedApart() public {
        uint256 id = _open(600e6, 400e6);
        vm.prank(exporter);
        dc.linkAgent(2);
        vm.prank(financier);
        uint256 off = dc.makeOffer(id, 900e6, uint64(block.timestamp + 1 days));
        vm.prank(exporter);
        dc.acceptOffer(off);
        vm.prank(financier);
        dc.cancel(id);
        assertEq(reg.count(), 2, "still one entry per refunded tranche");
        (uint256 agent,, int128 value,,, string memory t2,) = reg.feedbacks(1);
        assertEq(agent, 2);
        assertEq(value, 0);
        assertEq(t2, "assignee-cancelled");
    }

    /// L-1: a registry answering a huge return data must not make the caller pay to copy it
    function test_review3_L1_returnBombIsNotCopied() public {
        IERC20[] memory toks = new IERC20[](1);
        toks[0] = usdc;
        DocumentaryCredit bombed = new DocumentaryCredit(
            toks, IIdentityRegistry(address(reg)), IReputationRegistry(address(new ReturnBombRegistry())), address(this), 0
        );
        DocumentaryCredit.OpenParams memory p = _params(1000e6, 0);
        p.applicantAgent = 1 + 1;
        vm.startPrank(importer);
        usdc.approve(address(bombed), type(uint256).max);
        uint256 id = bombed.open(p, "");
        vm.stopPrank();
        vm.prank(exporter);
        bombed.linkAgent(2);
        vm.prank(forwarder);
        bombed.present(id, 0, 0, keccak256("bl"));
        vm.prank(inspector);
        uint256 g = gasleft();
        bombed.present(id, 0, 1, keccak256("insp")); // three feedback calls, each answering 288 KB
        uint256 used = g - gasleft();
        assertEq(usdc.balanceOf(exporter), 1000e6);
        assertEq(bombed.skippedFeedback(1), 0);
        // three callee budgets of 250k plus settlement; copying 3 x 288 KB would add over a million more
        assertLt(used, 1_100_000);
    }

    /// L-3: a proposer can take back its expiry proposal before the other side accepts it
    function test_review3_L3_expiryProposalWithdrawable() public {
        uint256 id = _open(1000e6, 0);
        vm.prank(importer);
        dc.amendExpiry(id, expiry + 10 days);
        vm.prank(exporter); // only the proposer
        vm.expectRevert(DocumentaryCredit.Unauthorized.selector);
        dc.withdrawExpiryProposal(id);
        vm.prank(importer);
        dc.withdrawExpiryProposal(id);
        assertEq(dc.expiryProposer(id), address(0));
        vm.prank(exporter); // would have matched the withdrawn proposal: now only a new proposal
        dc.amendExpiry(id, expiry + 10 days);
        assertEq(dc.getCredit(id).expiry, expiry);
        assertEq(dc.expiryProposer(id), exporter);
        vm.prank(importer); // nothing left to withdraw
        vm.expectRevert(DocumentaryCredit.Unauthorized.selector);
        dc.withdrawExpiryProposal(id);
    }

    /// L-4: the importer picks the integrator fee but the exporter pays it: it stays within the partner's own cap
    function test_review3_L4_integratorFeeCappedPerPartner() public {
        address partner = makeAddr("partner");
        dc.setPartner(partner, 2500, 20);
        assertEq(dc.partnerMaxFeeBps(partner), 20);
        DocumentaryCredit.OpenParams memory p = _params(1000e6, 0);
        p.partner = partner;
        p.integratorFeeBps = 21;
        _expectBad(p);
        p.integratorFeeBps = 20;
        vm.prank(importer);
        uint256 id = dc.open(p, "");
        assertEq(dc.getCredit(id).integratorFeeBps, 20);
        dc.setPartner(partner, 2500, 0); // a partner without a cap of its own charges nothing on top
        p.integratorFeeBps = 1;
        _expectBad(p);
        vm.expectRevert(DocumentaryCredit.BadParams.selector);
        dc.setPartner(partner, 2500, 51);
    }

    // ------------------------------------------------------------ settlement fee

    function test_fee_takenOnSettlementOnly_andSentToTreasury() public {
        dc.setFee(25);
        address treasury = makeAddr("treasury");
        dc.setTreasury(treasury);
        uint256 id = _open(6000e6, 4000e6);
        _presentBoth(id, 0);
        assertEq(usdc.balanceOf(exporter), 6000e6 - 15e6, "0.25% kept");
        assertEq(dc.fees(usdc), 15e6);
        vm.warp(expiry + 1);
        dc.reclaim(id);
        assertEq(usdc.balanceOf(importer), 1_000_000e6 - 6000e6, "refunds are free");
        vm.prank(stranger);
        dc.withdrawFees(usdc);
        assertEq(usdc.balanceOf(treasury), 15e6);
        assertEq(usdc.balanceOf(address(dc)), 0);
        vm.expectRevert(DocumentaryCredit.NothingOwed.selector);
        dc.withdrawFees(usdc);
    }

    function test_fee_fixedPerCredit_cappedAndOwnerOnly() public {
        dc.setFee(25);
        uint256 id = _open(1000e6, 0);
        dc.setFee(100);
        _presentBoth(id, 0);
        assertEq(usdc.balanceOf(exporter), 1000e6 - 2.5e6, "rate of the credit, not the new one");
        vm.expectRevert(DocumentaryCredit.BadParams.selector);
        dc.setFee(101);
        vm.prank(stranger);
        vm.expectRevert();
        dc.setFee(0);
        vm.prank(stranger);
        vm.expectRevert();
        dc.setTreasury(stranger);
    }

    // ------------------------------------------------------------ audit 2026-10-13

    /// An exporter cannot keep failing credits out of its record by linking per credit: the link is per address and
    /// covers credits opened before it.
    function test_audit_linkPerAddressCoversEveryCredit() public {
        uint256 id = _open(1000e6, 0);
        assertEq(dc.getCredit(id).beneficiaryAgent, 0);
        vm.prank(exporter);
        dc.linkAgent(2);
        assertEq(dc.getCredit(id).beneficiaryAgent, 3, "agentId + 1");
        vm.warp(expiry + 1);
        dc.reclaim(id);
        (uint256 agent,,,,, string memory t2,) = reg.feedbacks(0);
        assertEq(agent, 2);
        assertEq(t2, "expired");
    }

    /// Making this contract an operator of its own agent turns every entry into a refused self-feedback: the refusal
    /// is now counted, so the dodge leaves a public trace.
    function test_audit_refusedEntriesAreCounted() public {
        uint256 id = _open(1000e6, 0);
        vm.prank(exporter);
        dc.linkAgent(2);
        reg.setOwner(2, address(dc));
        vm.warp(expiry + 1);
        dc.reclaim(id);
        assertEq(reg.count(), 0);
        assertEq(dc.skippedFeedback(2), 1);
    }

    /// An offer cannot outlive the credit, and an extension agreed after the offer makes it stale.
    function test_audit_offerBoundToExpiry() public {
        uint256 id = _open(1000e6, 0);
        vm.startPrank(financier);
        vm.expectRevert(DocumentaryCredit.BadParams.selector);
        dc.makeOffer(id, 900e6, expiry + 1);
        uint256 off = dc.makeOffer(id, 900e6, expiry);
        vm.stopPrank();
        vm.prank(importer);
        dc.amendExpiry(id, expiry + 30 days);
        vm.prank(exporter);
        dc.amendExpiry(id, expiry + 30 days);
        vm.prank(exporter);
        vm.expectRevert(DocumentaryCredit.StaleOffer.selector);
        dc.acceptOffer(off);
    }

    // ------------------------------------------------------------ plans and partners

    function _pass() internal returns (CredocPass ps) {
        ps = new CredocPass(usdc, address(this), [uint96(49e6), 99e6, 299e6]);
        dc.setFee(25);
        dc.setPass(ICredocPass(address(ps)), 10);
    }

    function test_plan_importerOpensAtProRate() public {
        CredocPass ps = _pass();
        ps.grant(importer, 2, uint64(block.timestamp + 30 days));
        uint256 id = _open(1000e6, 0);
        assertEq(dc.getCredit(id).feeBps, 10);
        ps.grant(importer, 2, 0); // the rate stays the one the credit opened with
        _presentBoth(id, 0);
        assertEq(usdc.balanceOf(exporter), 1000e6 - 1e6);
        uint256 id2 = _open(1000e6, 0);
        assertEq(dc.getCredit(id2).feeBps, 25, "no plan, standard rate");
    }

    function test_plan_financierCollectsAtProRate() public {
        CredocPass ps = _pass();
        uint256 id = _open(1000e6, 0);
        vm.prank(financier);
        uint256 off = dc.makeOffer(id, 900e6, uint64(block.timestamp + 1 days));
        vm.prank(exporter);
        dc.acceptOffer(off);
        ps.grant(financier, 3, uint64(block.timestamp + 30 days));
        uint256 before = usdc.balanceOf(financier);
        _presentBoth(id, 0);
        assertEq(usdc.balanceOf(financier) - before, 1000e6 - 1e6);
    }

    /// review 2026-10-13 (I-1): a pass answering a non-boolean word gives no discount and blocks nothing
    function test_plan_malformedAnswerNeverBlocks() public {
        dc.setFee(25);
        dc.setPass(ICredocPass(address(new WeirdPass())), 10);
        uint256 id = _open(1000e6, 0);
        assertEq(dc.getCredit(id).feeBps, 25);
        _presentBoth(id, 0);
        assertEq(usdc.balanceOf(exporter), 1000e6 - 2.5e6);
    }

    function test_plan_brokenPassNeverBlocksSettlement() public {
        dc.setFee(25);
        dc.setPass(ICredocPass(address(reg)), 10); // has no isActive: every lookup fails, standard rate applies
        uint256 id = _open(1000e6, 0);
        assertEq(dc.getCredit(id).feeBps, 25);
        _presentBoth(id, 0);
        assertEq(usdc.balanceOf(exporter), 1000e6 - 2.5e6);
        vm.expectRevert(DocumentaryCredit.BadParams.selector);
        dc.setPass(ICredocPass(address(reg)), 101);
    }

    function _openVia(address partner, uint16 integ, uint128 a) internal returns (uint256) {
        DocumentaryCredit.OpenParams memory p = _params(a, 0);
        p.partner = partner;
        p.integratorFeeBps = integ;
        vm.prank(importer);
        return dc.open(p, "");
    }

    function test_partner_shareAndIntegratorFee() public {
        address partner = makeAddr("partner");
        dc.setFee(25);
        dc.setPartner(partner, 2500, 50); // a quarter of Credoc's fee
        uint256 id = _openVia(partner, 50, 10_000e6);
        dc.setPartner(partner, 5000, 50); // later changes never reach an open credit
        _presentBoth(id, 0);
        // fee 25 USDC, of which 6.25 to the partner; integrator fee 50 USDC; exporter gets the rest
        assertEq(usdc.balanceOf(exporter), 10_000e6 - 25e6 - 50e6);
        assertEq(dc.fees(usdc), 18.75e6);
        assertEq(dc.owed(partner, usdc), 6.25e6 + 50e6);
        vm.prank(partner);
        dc.withdrawOwed(usdc);
        assertEq(usdc.balanceOf(partner), 56.25e6);
        assertEq(usdc.balanceOf(address(dc)), 18.75e6);
    }

    /// review 2026-10-13 (M-1, L-1): only owner-registered partners qualify, never a party to the credit, so an
    /// importer cannot name itself (or any address) to skim the exporter or cut Credoc's fee
    function test_partner_onlyRegisteredAndNeverAParty() public {
        DocumentaryCredit.OpenParams memory p = _params(1000e6, 0);
        p.partner = makeAddr("integrator"); // not registered
        p.integratorFeeBps = 20;
        _expectBad(p);
        p.integratorFeeBps = 0;
        _expectBad(p);
        dc.setPartner(importer, 2500, 50);
        dc.setPartner(exporter, 2500, 50);
        p.partner = importer;
        _expectBad(p);
        p.partner = exporter;
        _expectBad(p);
        dc.setPartner(makeAddr("integrator"), 0, 50); // a zero share unregisters
        p.partner = makeAddr("integrator");
        _expectBad(p);
    }

    function test_partner_capsAndRules() public {
        address partner = makeAddr("partner");
        DocumentaryCredit.OpenParams memory p = _params(1000e6, 0);
        p.partner = partner;
        p.integratorFeeBps = 51;
        _expectBad(p);
        p.partner = address(0);
        p.integratorFeeBps = 10; // a fee needs someone to receive it
        _expectBad(p);
        p.partner = address(dc);
        p.integratorFeeBps = 0;
        _expectBad(p);
        vm.expectRevert(DocumentaryCredit.BadParams.selector);
        dc.setPartner(partner, 5001, 50);
        vm.expectRevert(DocumentaryCredit.BadParams.selector);
        dc.setPartner(address(0), 100, 50);
        vm.expectRevert(DocumentaryCredit.BadParams.selector);
        dc.setPartner(address(dc), 100, 50);
        vm.prank(stranger);
        vm.expectRevert();
        dc.setPartner(stranger, 5000, 50);
    }

    function test_partner_refundsAreFree() public {
        address partner = makeAddr("partner");
        dc.setFee(25);
        dc.setPartner(partner, 2500, 50);
        uint256 id = _openVia(partner, 50, 1000e6);
        vm.warp(expiry + 1);
        dc.reclaim(id);
        assertEq(usdc.balanceOf(importer), 1_000_000e6);
        assertEq(dc.owed(partner, usdc), 0);
    }
}

contract WeirdPass {
    function isActive(address, uint8) external pure returns (uint256) {
        return 2;
    }
}
