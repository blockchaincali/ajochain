// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title MockStabilityPool
/// @notice Test double for Mezo's MUSD StabilityPool, for local runs and tests only.
/// Mirrors the behaviour AjoManager depends on:
///  - provideToSP pulls MUSD with transferFrom and pays out pending BTC gains;
///  - withdrawFromSP returns min(amount, deposit) and pays out all BTC gains;
///  - withdrawals of a non-zero amount revert while `blocked` is set
///    (the real pool blocks them while a trove is under-collateralized);
///  - liquidate() shrinks every deposit pro rata and credits the BTC sent
///    with the call as gains, like a Stability Pool offset.
contract MockStabilityPool {
    IERC20 public immutable musd;
    bool public blocked;

    address[] internal depositors;
    mapping(address => bool) internal known;
    mapping(address => uint256) public deposits;
    mapping(address => uint256) public gains;

    constructor(IERC20 _musd) {
        musd = _musd;
    }

    function setBlocked(bool b) external {
        blocked = b;
    }

    function provideToSP(uint256 _amount) external {
        require(_amount > 0, "StabilityPool: Amount must be non-zero");
        require(musd.transferFrom(msg.sender, address(this), _amount), "transfer failed");
        if (!known[msg.sender]) {
            known[msg.sender] = true;
            depositors.push(msg.sender);
        }
        deposits[msg.sender] += _amount;
        _payGain(msg.sender);
    }

    function withdrawFromSP(uint256 _amount) external {
        if (_amount != 0) {
            require(!blocked, "StabilityPool: Cannot withdraw while there are troves with ICR < MCR");
        }
        require(known[msg.sender], "StabilityPool: User must have a non-zero deposit");
        uint256 d = deposits[msg.sender];
        uint256 w = _amount < d ? _amount : d;
        deposits[msg.sender] = d - w;
        if (w > 0) require(musd.transfer(msg.sender, w), "transfer failed");
        _payGain(msg.sender);
    }

    /// Simulate a liquidation absorbed by the pool: `debt` MUSD is burned from
    /// deposits pro rata and msg.value BTC is shared out as gains.
    function liquidate(uint256 debt) external payable {
        uint256 total;
        for (uint256 i = 0; i < depositors.length; i++) total += deposits[depositors[i]];
        require(total > 0 && debt <= total, "bad liquidation");
        for (uint256 i = 0; i < depositors.length; i++) {
            address a = depositors[i];
            uint256 d = deposits[a];
            deposits[a] = d - (debt * d) / total;
            gains[a] += (msg.value * d) / total;
        }
        if (debt > 0) require(musd.transfer(address(0xdead), debt), "burn failed");
    }

    function getCompoundedMUSDDeposit(address a) external view returns (uint256) {
        return deposits[a];
    }

    function getDepositorCollateralGain(address a) external view returns (uint256) {
        return gains[a];
    }

    function _payGain(address a) internal {
        uint256 g = gains[a];
        if (g == 0) return;
        gains[a] = 0;
        (bool ok,) = a.call{value: g}("");
        require(ok, "Sending BTC failed");
    }
}
