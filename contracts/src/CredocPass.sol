// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title CredocPass
/// @notice Prepaid Credoc plans, paid in USDC on Arc: pay N periods of 30 days, the plan is active until a date.
///         No recurring pull and no backend: the contract (`DocumentaryCredit` reads importer and financier plans to
///         lower its fee) and the relayer (attestor plans lift the free quota) only ask `isActive`.
///         Payments go straight to the treasury; this contract never holds funds.
contract CredocPass is Ownable2Step {
    using SafeERC20 for IERC20;

    uint8 public constant ATTESTOR = 1; // unlimited gasless presentations through the Credoc relayer
    uint8 public constant IMPORTER = 2; // lower settlement fee on credits opened while active, relays for its attestors
    uint8 public constant FINANCIER = 3; // lower settlement fee on proceeds collected while active
    uint8 public constant PLANS = 3;

    uint256 public constant PERIOD = 30 days;
    uint16 public constant MAX_PERIODS = 36;

    IERC20 public immutable usdc;
    address public treasury;
    mapping(uint8 => uint96) public price; // USDC (6 decimals) per period; 0 = not for sale
    mapping(address => mapping(uint8 => uint64)) public activeUntil;
    /// @dev "verified attestor" badge, granted after an offchain KYB check and never sold with a plan
    mapping(address => bool) public verified;

    event PassBought(address indexed account, uint8 indexed plan, uint64 until, address payer, uint256 paid);
    event PassGranted(address indexed account, uint8 indexed plan, uint64 until);
    event PriceChanged(uint8 indexed plan, uint96 price);
    event TreasuryChanged(address treasury);
    event Verified(address indexed account, bool verified);

    error BadParams();
    error NotForSale();

    constructor(IERC20 usdc_, address treasury_, uint96[3] memory prices) Ownable(msg.sender) {
        usdc = usdc_;
        setTreasury(treasury_);
        for (uint8 p = 1; p <= PLANS; p++) {
            setPrice(p, prices[p - 1]);
        }
    }

    /// @notice What `periods` periods of `plan` cost: every full year of 12 periods is charged as 10.
    function quote(uint8 plan, uint16 periods) public view returns (uint256) {
        return uint256(price[plan]) * (periods - 2 * (periods / 12));
    }

    /// @notice Buy or extend `plan` for `account`, by `periods` periods of 30 days. Anyone may pay for anyone, so an
    ///         importer can sponsor its forwarder. An active plan is extended from its current end, not from now.
    function buy(address account, uint8 plan, uint16 periods) external returns (uint64 until) {
        if (account == address(0) || plan == 0 || plan > PLANS || periods == 0 || periods > MAX_PERIODS) {
            revert BadParams();
        }
        uint256 cost = quote(plan, periods);
        if (cost == 0) revert NotForSale();
        uint256 from = activeUntil[account][plan] > block.timestamp ? activeUntil[account][plan] : block.timestamp;
        until = uint64(from + uint256(periods) * PERIOD);
        activeUntil[account][plan] = until;
        usdc.safeTransferFrom(msg.sender, treasury, cost);
        emit PassBought(account, plan, until, msg.sender, cost);
    }

    function isActive(address account, uint8 plan) external view returns (bool) {
        return activeUntil[account][plan] >= block.timestamp;
    }

    // ------------------------------------------------------------------ owner

    /// @notice Pilots and partners: set a plan's end date directly (0 ends it).
    function grant(address account, uint8 plan, uint64 until) external onlyOwner {
        if (plan == 0 || plan > PLANS) revert BadParams();
        activeUntil[account][plan] = until;
        emit PassGranted(account, plan, until);
    }

    /// @notice New price for future purchases; plans already bought keep their end date.
    function setPrice(uint8 plan, uint96 p) public onlyOwner {
        if (plan == 0 || plan > PLANS) revert BadParams();
        price[plan] = p;
        emit PriceChanged(plan, p);
    }

    function setTreasury(address to) public onlyOwner {
        if (to == address(0)) revert BadParams();
        treasury = to;
        emit TreasuryChanged(to);
    }

    function setVerified(address account, bool v) external onlyOwner {
        verified[account] = v;
        emit Verified(account, v);
    }
}
