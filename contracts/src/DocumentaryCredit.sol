// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @dev Subset of the ERC-8004 v2.0.0 registries deployed at their canonical addresses on Arc.
interface IIdentityRegistry {
    function isAuthorizedOrOwner(address spender, uint256 agentId) external view returns (bool);
}

interface IReputationRegistry {
    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) external;
}

/// @title DocumentaryCredit
/// @notice Cash-backed letters of credit for small importers, settled in USDC or EURC on Arc.
///
/// The importer (applicant) locks the full amount up front. The amount is split into tranches
/// (partial shipments). Each tranche is released to the payee the instant every required
/// document for it is presented by its nominated attestor (freight forwarder, inspector,
/// insurer...), or waived by the applicant (accepting a discrepancy). Unreleased tranches go back
/// to the applicant after expiry. The exporter (beneficiary) can assign the right to the proceeds
/// to a financier before shipment (UCP 600 art. 39), and every settled, expired or cancelled tranche
/// writes an ERC-8004 reputation entry that only a real settlement through this contract can produce.
contract DocumentaryCredit is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------ constants

    uint256 public constant MAX_DOCS = 8;
    uint256 public constant MAX_TRANCHES = 8;
    uint256 public constant MAX_TENOR = 730 days;

    bytes32 public constant PRESENTATION_TYPEHASH =
        keccak256("Presentation(uint256 creditId,uint8 tranche,uint8 doc,bytes32 docHash,uint256 deadline)");

    string public constant TAG = "credoc";
    /// @dev gas forwarded to each ERC-8004 call: bounded so an upgraded or broken registry cannot make
    ///      settlement exceed the block gas limit, and reserved so a caller cannot starve it on purpose.
    uint256 public constant FEEDBACK_GAS = 250_000;

    // ------------------------------------------------------------------ types

    enum Status {
        None,
        Active,
        Closed
    }

    struct DocRequirement {
        bytes32 docType; // e.g. keccak256("BILL_OF_LADING"), free-form label hash
        address attestor; // EOA or ERC-1271 wallet allowed to present this document
    }

    struct TrancheSpec {
        uint128 amount; // token units
        uint8 requiredDocs; // bitmask over the credit's document list
    }

    struct Tranche {
        uint128 amount;
        uint8 requiredDocs;
        uint8 satisfiedDocs;
        uint8 waivedDocs; // subset of satisfiedDocs accepted by the applicant without presentation
        bool settled;
    }

    struct Credit {
        address applicant;
        address beneficiary;
        address payee; // who receives proceeds; starts as beneficiary, changes on assignment
        IERC20 token;
        uint64 expiry;
        Status status;
        uint128 total;
        uint128 outstanding; // locked and not yet released or refunded
        uint256 applicantAgent; // ERC-8004 agentId + 1, 0 = none
        uint256 beneficiaryAgent; // ERC-8004 agentId + 1, 0 = none
        bytes32 terms; // hash of the off-chain contract (proforma invoice, incoterms...)
    }

    struct OpenParams {
        address beneficiary;
        IERC20 token;
        uint64 expiry;
        bytes32 terms;
        uint256 applicantAgent; // agentId + 1, 0 = none
        DocRequirement[] docs;
        TrancheSpec[] tranches;
    }

    struct Offer {
        uint256 creditId;
        address financier;
        uint128 price; // paid to the current payee on acceptance, escrowed here meanwhile
        uint128 forOutstanding; // offer only valid while outstanding equals this value
        uint64 validUntil;
        bool open;
    }

    // ------------------------------------------------------------------ storage

    IIdentityRegistry public immutable identityRegistry;
    IReputationRegistry public immutable reputationRegistry;

    mapping(IERC20 => bool) public isAllowedToken;
    /// @dev per-token ERC-8004 tag so dollar and euro volumes are never averaged together
    mapping(IERC20 => string) public volumeTag;

    uint256 public creditCount;
    mapping(uint256 => Credit) internal _credits;
    mapping(uint256 => DocRequirement[]) internal _docs;
    mapping(uint256 => Tranche[]) internal _tranches;
    /// @dev creditId => tranche * MAX_DOCS + doc => document hash (0 = waived)
    mapping(uint256 => mapping(uint256 => bytes32)) public presentedHash;
    /// @dev creditId => proposed new expiry and its proposer
    mapping(uint256 => uint64) public proposedExpiry;
    mapping(uint256 => address) public expiryProposer;

    uint256 public offerCount;
    mapping(uint256 => Offer) public offers;

    /// @dev funds that could not be pushed (e.g. blocklisted payee), withdrawable later
    mapping(address => mapping(IERC20 => uint256)) public owed;

    // ------------------------------------------------------------------ events

    event CreditOpened(
        uint256 indexed creditId,
        address indexed applicant,
        address indexed beneficiary,
        address token,
        uint128 total,
        uint64 expiry,
        bytes32 terms,
        string ref
    );
    event BeneficiaryAgentLinked(uint256 indexed creditId, uint256 agentId);
    event DocumentPresented(
        uint256 indexed creditId, uint8 indexed tranche, uint8 doc, bytes32 docType, bytes32 docHash, address attestor
    );
    event DocumentWaived(uint256 indexed creditId, uint8 indexed tranche, uint8 doc, bytes32 docType);
    event TrancheSettled(uint256 indexed creditId, uint8 indexed tranche, address indexed payee, uint128 amount);
    event TrancheRefunded(uint256 indexed creditId, uint8 indexed tranche, uint128 amount);
    event CreditClosed(uint256 indexed creditId, bool fullyDelivered);
    event ExpiryProposed(uint256 indexed creditId, address indexed proposer, uint64 newExpiry);
    event ExpiryAmended(uint256 indexed creditId, uint64 newExpiry);
    event OfferMade(
        uint256 indexed offerId, uint256 indexed creditId, address indexed financier, uint128 price, uint64 validUntil
    );
    event OfferWithdrawn(uint256 indexed offerId);
    event ProceedsAssigned(
        uint256 indexed creditId, uint256 indexed offerId, address indexed from, address to, uint128 price
    );
    event PaymentDeferred(address indexed to, address indexed token, uint256 amount);
    event ReputationSkipped(uint256 indexed creditId, uint256 agentId);

    // ------------------------------------------------------------------ errors

    error TokenNotAllowed();
    error BadParams();
    error NotActive();
    error Unauthorized();
    error Expired();
    error NotExpired();
    error AlreadySatisfied();
    error NotRequired();
    error BadSignature();
    error SignatureExpired();
    error OfferUnavailable();
    error StaleOffer();
    error NothingOwed();
    error AlreadyLinked();
    error InsufficientGas();

    // ------------------------------------------------------------------ constructor

    constructor(IERC20[] memory tokens, IIdentityRegistry identity, IReputationRegistry reputation)
        EIP712("DocumentaryCredit", "1")
    {
        for (uint256 i; i < tokens.length; i++) {
            isAllowedToken[tokens[i]] = true;
            volumeTag[tokens[i]] = string.concat("volume-", IERC20Metadata(address(tokens[i])).symbol());
        }
        identityRegistry = identity;
        reputationRegistry = reputation;
    }

    // ------------------------------------------------------------------ issuance

    /// @notice Open a credit and lock the full amount. Caller is the applicant and must have approved `token`.
    function open(OpenParams calldata p, string calldata ref) external nonReentrant returns (uint256 id) {
        if (!isAllowedToken[p.token]) revert TokenNotAllowed();
        if (
            p.beneficiary == address(0) || p.beneficiary == msg.sender || p.beneficiary == address(this)
                || p.expiry <= block.timestamp
                || p.expiry > block.timestamp + MAX_TENOR
        ) revert BadParams();
        uint256 nDocs = p.docs.length;
        uint256 nTr = p.tranches.length;
        if (nDocs == 0 || nDocs > MAX_DOCS || nTr == 0 || nTr > MAX_TRANCHES) revert BadParams();

        id = ++creditCount;

        uint8 allDocs = uint8((1 << nDocs) - 1);
        for (uint256 i; i < nDocs; i++) {
            DocRequirement calldata d = p.docs[i];
            if (d.attestor == address(0) || d.attestor == msg.sender || d.attestor == p.beneficiary) {
                revert BadParams();
            }
            _docs[id].push(d);
        }

        uint256 total;
        for (uint256 i; i < nTr; i++) {
            TrancheSpec calldata t = p.tranches[i];
            if (t.amount == 0 || t.requiredDocs == 0 || t.requiredDocs & ~allDocs != 0) revert BadParams();
            total += t.amount;
            _tranches[id].push(
                Tranche({amount: t.amount, requiredDocs: t.requiredDocs, satisfiedDocs: 0, waivedDocs: 0, settled: false})
            );
        }
        // bounded by int128 so amounts can be written as signed ERC-8004 feedback values
        if (total > uint256(uint128(type(int128).max))) revert BadParams();

        if (p.applicantAgent != 0 && !_controlsAgent(msg.sender, p.applicantAgent - 1)) revert Unauthorized();

        _credits[id] = Credit({
            applicant: msg.sender,
            beneficiary: p.beneficiary,
            payee: p.beneficiary,
            token: p.token,
            expiry: p.expiry,
            status: Status.Active,
            total: uint128(total),
            outstanding: uint128(total),
            applicantAgent: p.applicantAgent,
            beneficiaryAgent: 0,
            terms: p.terms
        });

        p.token.safeTransferFrom(msg.sender, address(this), total);

        emit CreditOpened(id, msg.sender, p.beneficiary, address(p.token), uint128(total), p.expiry, p.terms, ref);
    }

    /// @notice The beneficiary links its ERC-8004 identity so settlements build its track record.
    ///         Once only: relinking a throwaway identity before expiry would dodge negative entries.
    function linkBeneficiaryAgent(uint256 id, uint256 agentId) external {
        Credit storage c = _active(id);
        if (msg.sender != c.beneficiary || !_controlsAgent(msg.sender, agentId)) revert Unauthorized();
        if (c.beneficiaryAgent != 0) revert AlreadyLinked();
        c.beneficiaryAgent = agentId + 1;
        emit BeneficiaryAgentLinked(id, agentId);
    }

    // ------------------------------------------------------------------ presentation

    /// @notice Present a document as its nominated attestor.
    function present(uint256 id, uint8 tranche, uint8 doc, bytes32 docHash) external nonReentrant {
        _present(id, tranche, doc, docHash, msg.sender);
    }

    /// @notice Relay a presentation signed off-chain (EIP-712) by the attestor, who then needs no gas.
    function presentWithSig(
        uint256 id,
        uint8 tranche,
        uint8 doc,
        bytes32 docHash,
        uint256 deadline,
        bytes calldata signature
    ) external nonReentrant {
        if (block.timestamp > deadline) revert SignatureExpired();
        address attestor = _docRequirement(id, doc).attestor;
        bytes32 digest =
            _hashTypedDataV4(keccak256(abi.encode(PRESENTATION_TYPEHASH, id, tranche, doc, docHash, deadline)));
        if (!SignatureChecker.isValidSignatureNow(attestor, digest, signature)) revert BadSignature();
        _present(id, tranche, doc, docHash, attestor);
    }

    /// @notice The applicant accepts a missing or discrepant document (UCP 600 art. 16 waiver).
    function waive(uint256 id, uint8 tranche, uint8 doc) external nonReentrant {
        Credit storage c = _active(id);
        if (msg.sender != c.applicant) revert Unauthorized();
        Tranche storage t = _markSatisfied(id, tranche, doc);
        t.waivedDocs |= uint8(1 << doc);
        emit DocumentWaived(id, tranche, doc, _docs[id][doc].docType);
        _maybeSettle(id, c, tranche, t);
    }

    function _present(uint256 id, uint8 tranche, uint8 doc, bytes32 docHash, address attestor) internal {
        Credit storage c = _active(id);
        if (block.timestamp > c.expiry) revert Expired();
        DocRequirement storage d = _docRequirement(id, doc);
        if (attestor != d.attestor) revert Unauthorized();
        if (docHash == bytes32(0)) revert BadParams();
        Tranche storage t = _markSatisfied(id, tranche, doc);
        presentedHash[id][uint256(tranche) * MAX_DOCS + doc] = docHash;
        emit DocumentPresented(id, tranche, doc, d.docType, docHash, attestor);
        _maybeSettle(id, c, tranche, t);
    }

    function _markSatisfied(uint256 id, uint8 tranche, uint8 doc) internal returns (Tranche storage t) {
        if (tranche >= _tranches[id].length) revert BadParams();
        t = _tranches[id][tranche];
        uint8 bit = uint8(1 << doc);
        if (doc >= MAX_DOCS || t.requiredDocs & bit == 0) revert NotRequired();
        if (t.settled || t.satisfiedDocs & bit != 0) revert AlreadySatisfied();
        t.satisfiedDocs |= bit;
    }

    function _maybeSettle(uint256 id, Credit storage c, uint8 tranche, Tranche storage t) internal {
        if (t.satisfiedDocs != t.requiredDocs) return;
        t.settled = true;
        c.outstanding -= t.amount;
        address payee = c.payee;
        bool last = c.outstanding == 0;
        if (last) c.status = Status.Closed;

        _pay(c.token, payee, t.amount);
        emit TrancheSettled(id, tranche, payee, t.amount);

        // a tranche settled through waivers is recorded apart: the applicant alone can produce it
        string memory outcome = t.waivedDocs == 0 ? "delivered" : "waived";
        string memory vTag = volumeTag[c.token];
        _feedback(id, tranche, c.beneficiaryAgent, 100, 0, outcome, t.amount);
        _feedback(id, tranche, c.beneficiaryAgent, int128(t.amount), 6, vTag, t.amount);
        _feedback(id, tranche, c.applicantAgent, int128(t.amount), 6, vTag, t.amount);

        if (last) emit CreditClosed(id, true);
    }

    // ------------------------------------------------------------------ expiry, amendment, cancellation

    /// @notice After expiry, refund every unsettled tranche to the applicant. Callable by anyone.
    function reclaim(uint256 id) external nonReentrant {
        Credit storage c = _active(id);
        if (block.timestamp <= c.expiry) revert NotExpired();
        _refundAll(id, c, "expired");
        emit CreditClosed(id, false);
    }

    /// @notice The payee renounces the remaining proceeds (irrevocable credits only end early with its consent).
    function cancel(uint256 id) external nonReentrant {
        Credit storage c = _active(id);
        if (msg.sender != c.payee) revert Unauthorized();
        _refundAll(id, c, "cancelled");
        emit CreditClosed(id, false);
    }

    /// @notice Either party proposes a new expiry; the other party (the payee on the exporter side) accepts it
    ///         by proposing the same value. Mirrors UCP 600 art. 10: amendments need both sides.
    function amendExpiry(uint256 id, uint64 newExpiry) external {
        Credit storage c = _active(id);
        bool isApplicant = msg.sender == c.applicant;
        if (!isApplicant && msg.sender != c.payee) revert Unauthorized();
        // a lapsed credit cannot be revived, and expiry can only move later: shortening it would let the parties
        // strand a financier who bought the proceeds against the current expiry
        if (block.timestamp > c.expiry) revert Expired();
        if (newExpiry <= c.expiry || newExpiry > block.timestamp + MAX_TENOR) revert BadParams();

        address proposer = expiryProposer[id];
        if (proposer != address(0) && proposer != msg.sender && proposedExpiry[id] == newExpiry) {
            c.expiry = newExpiry;
            delete proposedExpiry[id];
            delete expiryProposer[id];
            emit ExpiryAmended(id, newExpiry);
        } else {
            proposedExpiry[id] = newExpiry;
            expiryProposer[id] = msg.sender;
            emit ExpiryProposed(id, msg.sender, newExpiry);
        }
    }

    /// @dev Refunds every unsettled tranche, then records one negative entry per refunded tranche (`outcome`),
    ///      so the track record counts tranches on both sides of the ratio.
    function _refundAll(uint256 id, Credit storage c, string memory outcome) internal {
        Tranche[] storage ts = _tranches[id];
        uint128 refunded;
        uint256 refundedMask;
        for (uint256 i; i < ts.length; i++) {
            if (ts[i].settled) continue;
            ts[i].settled = true;
            refunded += ts[i].amount;
            refundedMask |= 1 << i;
            // forge-lint: disable-next-line(unsafe-typecast)
            emit TrancheRefunded(id, uint8(i), ts[i].amount); // i < MAX_TRANCHES
        }
        c.outstanding = 0;
        c.status = Status.Closed;
        _pay(c.token, c.applicant, refunded);
        for (uint256 i; i < ts.length; i++) {
            // forge-lint: disable-next-line(unsafe-typecast)
            if (refundedMask & (1 << i) != 0) _feedback(id, uint8(i), c.beneficiaryAgent, 0, 0, outcome, ts[i].amount);
        }
    }

    // ------------------------------------------------------------------ forfaiting market

    /// @notice A financier offers to buy the remaining proceeds now, at `price`, escrowed until accepted or withdrawn.
    ///         Assignment of proceeds (UCP 600 art. 39): the beneficiary still ships and presents, the financier collects.
    function makeOffer(uint256 id, uint128 price, uint64 validUntil) external nonReentrant returns (uint256 offerId) {
        Credit storage c = _active(id);
        if (block.timestamp > c.expiry) revert Expired();
        if (price == 0 || price > c.outstanding || validUntil <= block.timestamp) revert BadParams();
        offerId = ++offerCount;
        offers[offerId] = Offer({
            creditId: id,
            financier: msg.sender,
            price: price,
            forOutstanding: c.outstanding,
            validUntil: validUntil,
            open: true
        });
        c.token.safeTransferFrom(msg.sender, address(this), price);
        emit OfferMade(offerId, id, msg.sender, price, validUntil);
    }

    /// @notice The financier takes back an unaccepted offer, at any time.
    function withdrawOffer(uint256 offerId) external nonReentrant {
        Offer storage o = offers[offerId];
        if (!o.open || msg.sender != o.financier) revert OfferUnavailable();
        o.open = false;
        _pay(_credits[o.creditId].token, o.financier, o.price);
        emit OfferWithdrawn(offerId);
    }

    /// @notice The current payee sells the remaining proceeds to the offer's financier. Works for resales too.
    function acceptOffer(uint256 offerId) external nonReentrant {
        Offer storage o = offers[offerId];
        if (!o.open || block.timestamp > o.validUntil) revert OfferUnavailable();
        Credit storage c = _active(o.creditId);
        if (msg.sender != c.payee) revert Unauthorized();
        if (block.timestamp > c.expiry) revert Expired();
        if (c.outstanding != o.forOutstanding) revert StaleOffer();

        o.open = false;
        address seller = c.payee;
        c.payee = o.financier;
        // a pending expiry proposal from the old payee must not bind the new one
        if (expiryProposer[o.creditId] == seller) {
            delete proposedExpiry[o.creditId];
            delete expiryProposer[o.creditId];
        }
        // direct transfer, not _pay: a blocklisted payee must not be able to sell its proceeds
        c.token.safeTransfer(seller, o.price);
        emit ProceedsAssigned(o.creditId, offerId, seller, o.financier, o.price);
    }

    // ------------------------------------------------------------------ payments

    /// @notice Withdraw funds that could not be pushed earlier.
    function withdrawOwed(IERC20 token) external nonReentrant {
        uint256 amount = owed[msg.sender][token];
        if (amount == 0) revert NothingOwed();
        owed[msg.sender][token] = 0;
        token.safeTransfer(msg.sender, amount);
    }

    /// @dev Push payment; if the transfer fails (blocklisted recipient, paused token), keep it claimable so one
    ///      bad recipient can never block settlement of the credit.
    function _pay(IERC20 token, address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok, bytes memory ret) = address(token).call(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (ok && (ret.length == 0 ? address(token).code.length > 0 : abi.decode(ret, (bool)))) return;
        owed[to][token] += amount;
        emit PaymentDeferred(to, address(token), amount);
    }

    // ------------------------------------------------------------------ ERC-8004

    function _controlsAgent(address who, uint256 agentId) internal view returns (bool) {
        if (address(identityRegistry).code.length == 0) return false;
        try identityRegistry.isAuthorizedOrOwner(who, agentId) returns (bool ok) {
            return ok;
        } catch {
            return false;
        }
    }

    /// @dev A registry failure never blocks money movement: each call gets a fixed gas budget and any revert is
    ///      caught. The caller must leave that budget available, so nobody can skip an entry by starving the call.
    function _feedback(
        uint256 id,
        uint8 tranche,
        uint256 agentPlusOne,
        int128 value,
        uint8 decimals,
        string memory tag2,
        uint128 amount
    ) internal {
        if (agentPlusOne == 0 || address(reputationRegistry).code.length == 0) return;
        if (gasleft() < FEEDBACK_GAS * 64 / 63 + 10_000) revert InsufficientGas();
        bytes memory call = abi.encodeCall(
            IReputationRegistry.giveFeedback,
            (
                agentPlusOne - 1,
                value,
                decimals,
                TAG,
                tag2,
                "",
                _feedbackURI(id),
                keccak256(abi.encode(id, tranche, amount, tag2))
            )
        );
        (bool ok,) = address(reputationRegistry).call{gas: FEEDBACK_GAS}(call);
        if (!ok) emit ReputationSkipped(id, agentPlusOne - 1);
    }

    function _feedbackURI(uint256 id) internal view returns (string memory) {
        return string.concat(
            "credoc:", Strings.toString(block.chainid), ":", Strings.toHexString(address(this)), ":", Strings.toString(id)
        );
    }

    // ------------------------------------------------------------------ views

    function _active(uint256 id) internal view returns (Credit storage c) {
        c = _credits[id];
        if (c.status != Status.Active) revert NotActive();
    }

    function _docRequirement(uint256 id, uint8 doc) internal view returns (DocRequirement storage) {
        if (doc >= _docs[id].length) revert BadParams();
        return _docs[id][doc];
    }

    function getCredit(uint256 id) external view returns (Credit memory) {
        return _credits[id];
    }

    function getDocs(uint256 id) external view returns (DocRequirement[] memory) {
        return _docs[id];
    }

    function getTranches(uint256 id) external view returns (Tranche[] memory) {
        return _tranches[id];
    }

    function presentationDigest(uint256 id, uint8 tranche, uint8 doc, bytes32 docHash, uint256 deadline)
        external
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(keccak256(abi.encode(PRESENTATION_TYPEHASH, id, tranche, doc, docHash, deadline)));
    }
}
