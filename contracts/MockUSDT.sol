// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockUSDT
/// @notice Test stablecoin for the Portaldot testnet demo. Anyone can claim
/// 1,000 tokens from the faucet. NOT for production use.
contract MockUSDT is ERC20 {
    uint256 public constant FAUCET_AMOUNT = 1_000 ether;

    constructor() ERC20("Ajo Test USD", "aUSD") {}

    function faucet() external {
        _mint(msg.sender, FAUCET_AMOUNT);
    }
}
