// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice The subset of Mezo's MUSD StabilityPool that AjoChain uses.
/// Source: github.com/mezo-org/musd, solidity/contracts/StabilityPool.sol.
/// Deposits absorb liquidated MUSD debt and earn the liquidated BTC collateral.
/// BTC gains are paid as native BTC (Mezo's gas token) on every
/// provideToSP / withdrawFromSP call.
interface IStabilityPool {
    /// Pulls `_amount` MUSD from the caller (needs ERC-20 approval) and pays out
    /// any pending BTC gain.
    function provideToSP(uint256 _amount) external;

    /// Sends up to `_amount` MUSD back and pays out all pending BTC gain.
    /// Reverts while any trove is below the minimum collateral ratio
    /// (only when `_amount != 0`).
    function withdrawFromSP(uint256 _amount) external;

    function getCompoundedMUSDDeposit(address _depositor) external view returns (uint256);

    function getDepositorCollateralGain(address _depositor) external view returns (uint256);
}
