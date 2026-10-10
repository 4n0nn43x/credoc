// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {DocumentaryCredit, IIdentityRegistry, IReputationRegistry} from "../src/DocumentaryCredit.sol";
import {ArcMainnet} from "../script/ArcMainnet.sol";

interface IIdentity {
    function register(string calldata agentURI) external returns (uint256);
}

interface IReputation {
    function getSummary(uint256 agentId, address[] calldata clients, string calldata tag1, string calldata tag2)
        external
        view
        returns (uint64 count, int128 value, uint8 decimals);
}

interface IMulticall3From {
    struct Call3 {
        address target;
        bool allowFailure;
        bytes callData;
    }

    struct Result {
        bool success;
        bytes returnData;
    }

    function aggregate3(Call3[] calldata calls) external returns (Result[] memory);
}

interface IMemo {
    function memo(address target, bytes calldata data, bytes32 memoId, bytes calldata memoData) external;
}

/// @notice End-to-end against real Arc mainnet state: native USDC, EURC, ERC-8004 v2 registries, Memo.
/// Run with Arc Foundry (stock forge cannot execute Arc's USDC precompile):
///   arc-forge test --match-contract ForkTest --fork-url https://rpc.mainnet.arc.io
contract ForkTest is Test {
    IERC20 constant USDC = IERC20(ArcMainnet.USDC);
    IERC20 constant EURC = IERC20(ArcMainnet.EURC);
    address constant EURC_WHALE = 0xbe080aC37ad1305DFCc9521F5e6F68CFDc41B7fa;

    DocumentaryCredit dc;
    address importer = makeAddr("importer");
    address exporter = makeAddr("exporter");
    uint256 fwdKey = 0xF0;
    address forwarder;
    uint256 exporterAgent;
    uint256 importerAgent;

    function setUp() public {
        if (block.chainid != 5042) return;
        forwarder = vm.addr(fwdKey);
        IERC20[] memory toks = new IERC20[](2);
        toks[0] = USDC;
        toks[1] = EURC;
        dc = new DocumentaryCredit(
            toks, IIdentityRegistry(ArcMainnet.IDENTITY_REGISTRY), IReputationRegistry(ArcMainnet.REPUTATION_REGISTRY)
        );
        vm.deal(importer, 50e18); // native USDC: 18 decimals, mirrored as 50e6 on the ERC-20 interface
        vm.prank(exporter);
        exporterAgent = IIdentity(ArcMainnet.IDENTITY_REGISTRY).register("ipfs://exporter");
        vm.prank(importer);
        importerAgent = IIdentity(ArcMainnet.IDENTITY_REGISTRY).register("ipfs://importer");
    }

    modifier onlyArc() {
        if (block.chainid != 5042) {
            vm.skip(true);
        }
        _;
    }

    function _params(IERC20 token, uint128 amount) internal view returns (DocumentaryCredit.OpenParams memory p) {
        p.beneficiary = exporter;
        p.token = token;
        p.expiry = uint64(block.timestamp + 7 days);
        p.terms = keccak256("PO-ARC-1");
        p.applicantAgent = importerAgent + 1;
        p.docs = new DocumentaryCredit.DocRequirement[](1);
        p.docs[0] = DocumentaryCredit.DocRequirement(keccak256("BILL_OF_LADING"), forwarder);
        p.tranches = new DocumentaryCredit.TrancheSpec[](1);
        p.tranches[0] = DocumentaryCredit.TrancheSpec(amount, 1);
    }

    function test_fork_usdc_fullFlow_withRealReputation() public onlyArc {
        assertEq(USDC.balanceOf(importer), 50e6);
        vm.startPrank(importer);
        USDC.approve(address(dc), 10e6);
        uint256 id = dc.open(_params(USDC, 10e6), "PO-ARC-1");
        vm.stopPrank();
        assertEq(USDC.balanceOf(address(dc)), 10e6);

        vm.prank(exporter);
        dc.linkBeneficiaryAgent(id, exporterAgent);

        uint256 dl = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(fwdKey, dc.presentationDigest(id, 0, 0, keccak256("bl"), dl));
        dc.presentWithSig(id, 0, 0, keccak256("bl"), dl, abi.encodePacked(r, s, v));

        assertEq(USDC.balanceOf(exporter), 10e6);
        assertEq(exporter.balance, 10e18, "native view of the same balance");

        address[] memory clients = new address[](1);
        clients[0] = address(dc);
        IReputation rep = IReputation(ArcMainnet.REPUTATION_REGISTRY);
        (uint64 n, int128 val,) = rep.getSummary(exporterAgent, clients, "credoc", "delivered");
        assertEq(n, 1);
        assertEq(val, 100);
        (n, val,) = rep.getSummary(exporterAgent, clients, "credoc", "volume-USDC");
        assertEq(val, 10e6);
        (n,,) = rep.getSummary(importerAgent, clients, "credoc", "volume-USDC");
        assertEq(n, 1);
    }

    function test_fork_eurc_expiryRefund() public onlyArc {
        vm.prank(EURC_WHALE);
        EURC.transfer(importer, 20e6);
        vm.startPrank(importer);
        EURC.approve(address(dc), 20e6);
        uint256 id = dc.open(_params(EURC, 20e6), "");
        vm.stopPrank();
        vm.prank(exporter);
        dc.linkBeneficiaryAgent(id, exporterAgent);
        vm.warp(block.timestamp + 8 days);
        dc.reclaim(id);
        assertEq(EURC.balanceOf(importer), 20e6);

        address[] memory clients = new address[](1);
        clients[0] = address(dc);
        (uint64 n, int128 val,) =
            IReputation(ArcMainnet.REPUTATION_REGISTRY).getSummary(exporterAgent, clients, "credoc", "expired");
        assertEq(n, 1);
        assertEq(val, 0);
    }

    /// The applicant can wrap `open` in Arc's Memo so the purchase-order reference is indexed by Arc tooling,
    /// while msg.sender stays the applicant (CallFrom precompile).
    function test_fork_openThroughMemo() public onlyArc {
        vm.startPrank(importer, importer);
        USDC.approve(address(dc), 5e6);
        bytes memory data = abi.encodeCall(DocumentaryCredit.open, (_params(USDC, 5e6), "PO-ARC-2"));
        vm.recordLogs();
        IMemo(ArcMainnet.MEMO).memo(address(dc), data, keccak256("PO-ARC-2"), bytes("PO-ARC-2"));
        vm.stopPrank();

        DocumentaryCredit.Credit memory c = dc.getCredit(1);
        assertEq(c.applicant, importer, "Memo preserved the sender");
        assertEq(USDC.balanceOf(address(dc)), 5e6);

        bool seen;
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == ArcMainnet.MEMO && logs[i].topics.length == 4) {
                assertEq(logs[i].topics[3], keccak256("PO-ARC-2"));
                seen = true;
            }
        }
        assertTrue(seen, "Memo event with the PO reference");
    }

    /// One transaction for the importer: approve + Memo-tagged open, batched by Arc's Multicall3From.
    function test_fork_oneClickOpen_multicallApproveAndMemo() public onlyArc {
        IMulticall3From.Call3[] memory calls = new IMulticall3From.Call3[](2);
        calls[0] = IMulticall3From.Call3(address(USDC), false, abi.encodeCall(IERC20.approve, (address(dc), 7e6)));
        calls[1] = IMulticall3From.Call3(
            ArcMainnet.MEMO,
            false,
            abi.encodeCall(
                IMemo.memo,
                (
                    address(dc),
                    abi.encodeCall(DocumentaryCredit.open, (_params(USDC, 7e6), "PO-ARC-3")),
                    keccak256("PO-ARC-3"),
                    bytes("PO-ARC-3")
                )
            )
        );
        vm.prank(importer, importer);
        IMulticall3From(ArcMainnet.MULTICALL3_FROM).aggregate3(calls);
        assertEq(dc.getCredit(1).applicant, importer);
        assertEq(USDC.balanceOf(address(dc)), 7e6);
        assertEq(USDC.allowance(importer, address(dc)), 0);
    }
}
