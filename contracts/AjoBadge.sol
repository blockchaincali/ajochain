// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title AjoBadge
/// @notice Soulbound (non-transferable) ERC-721 minted to every member who
/// completes a full AjoChain savings cycle without defaulting. A wallet's badge
/// count is a portable, on-chain savings and repayment history.
contract AjoBadge is ERC721, Ownable {
    struct BadgeInfo {
        uint256 groupId;
        uint256 contribution;
        uint8 cycleSize;
        uint64 completedAt;
    }

    address public minter;
    uint256 public totalMinted;
    mapping(uint256 => BadgeInfo) public badgeInfo;

    event MinterSet(address indexed minter);
    event BadgeMinted(address indexed to, uint256 indexed tokenId, uint256 indexed groupId);

    error NotMinter();
    error Soulbound();

    constructor(address initialOwner) ERC721("AjoChain Completion Badge", "AJOB") Ownable(initialOwner) {}

    function setMinter(address _minter) external onlyOwner {
        minter = _minter;
        emit MinterSet(_minter);
    }

    function mint(address to, uint256 groupId, uint256 contribution, uint8 cycleSize)
        external
        returns (uint256 tokenId)
    {
        if (msg.sender != minter) revert NotMinter();
        tokenId = ++totalMinted;
        badgeInfo[tokenId] = BadgeInfo(groupId, contribution, cycleSize, uint64(block.timestamp));
        _mint(to, tokenId);
        emit BadgeMinted(to, tokenId, groupId);
    }

    /// @dev Block transfers: only minting (from == 0) and burning (to == 0) are allowed.
    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        address from = _ownerOf(tokenId);
        if (from != address(0) && to != address(0)) revert Soulbound();
        return super._update(to, tokenId, auth);
    }
}
