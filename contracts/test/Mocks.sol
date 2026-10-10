// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockToken is ERC20 {
    mapping(address => bool) public blocked;

    constructor(string memory n) ERC20(n, n) {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 a) external {
        _mint(to, a);
    }

    /// @dev mimics the USDC/EURC blocklist: transfers to or from a blocked address revert
    function setBlocked(address a, bool b) external {
        blocked[a] = b;
    }

    function _update(address from, address to, uint256 v) internal override {
        require(!blocked[from] && !blocked[to], "blocked");
        super._update(from, to, v);
    }
}

/// @dev Behaves like the ERC-8004 v2.0.0 registries for what DocumentaryCredit uses.
contract MockRegistries {
    mapping(uint256 => address) public ownerOf;
    bool public broken;
    bool public burn; // simulates a malicious or broken upgrade that consumes all forwarded gas

    struct Fb {
        uint256 agentId;
        address client;
        int128 value;
        uint8 decimals;
        string tag1;
        string tag2;
        string uri;
    }

    Fb[] public feedbacks;

    function setOwner(uint256 agentId, address o) external {
        ownerOf[agentId] = o;
    }

    function setBroken(bool b) external {
        broken = b;
    }

    function setBurn(bool b) external {
        burn = b;
    }

    function isAuthorizedOrOwner(address spender, uint256 agentId) external view returns (bool) {
        require(ownerOf[agentId] != address(0), "ERC721NonexistentToken");
        return ownerOf[agentId] == spender;
    }

    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata,
        string calldata uri,
        bytes32
    ) external {
        require(!broken, "upgraded");
        if (burn) {
            while (true) {}
        }
        require(ownerOf[agentId] != address(0), "ERC721NonexistentToken");
        require(ownerOf[agentId] != msg.sender, "Self-feedback not allowed");
        feedbacks.push(Fb(agentId, msg.sender, value, valueDecimals, tag1, tag2, uri));
    }

    function count() external view returns (uint256) {
        return feedbacks.length;
    }
}
