// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {AjoBadge} from "./AjoBadge.sol";
import {IStabilityPool} from "./interfaces/IStabilityPool.sol";

/// @title AjoManager (Mezo edition)
/// @notice Trustless rotating savings groups (ajo / esusu / ROSCA) saved in MUSD,
/// Mezo's Bitcoin-backed stablecoin.
///
/// Members lock one contribution as collateral when they join. Every round each
/// member pays the fixed contribution and the whole pot goes to one member, in
/// join order, until everyone has been paid once. If a member misses a round,
/// anyone can close the round after its deadline: the defaulter's collateral
/// covers the missed payment and they lose their completion badge.
///
/// "Earn while you save": an MUSD circle can opt to park its locked collateral in
/// Mezo's MUSD Stability Pool for the whole cycle. The pool uses deposits to
/// absorb liquidated MUSD debt and pays depositors the liquidated BTC, so the
/// collateral earns BTC instead of sitting idle. At the end of the cycle members
/// get their MUSD collateral back and claim their share of the BTC earned.
///
/// All circles share one Stability Pool deposit (this contract's). A share
/// system splits that deposit, and the BTC it earns, between circles.
contract AjoManager is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Status {
        Open,
        Active,
        Completed
    }

    struct Group {
        string name;
        address creator;
        IERC20 token;
        uint256 contribution;
        uint64 roundDuration;
        uint64 roundDeadline;
        uint8 maxMembers;
        uint8 currentRound;
        uint8 paidCount;
        Status status;
        uint256 pot;
        bool earnsYield; // collateral is deposited in the Mezo Stability Pool
        bool refundPending; // cycle finished but the pool was temporarily locked; see finalizeRefunds()
    }

    uint8 public constant MIN_MEMBERS = 2;
    uint8 public constant MAX_MEMBERS = 20;
    uint64 public constant MIN_ROUND_DURATION = 60; // 1 minute, so demos are quick
    uint256 private constant ACC = 1e18; // fixed-point scale for accBtcPerShare

    AjoBadge public immutable badge;
    /// MUSD token (the only token that can earn yield). address(0) disables yield.
    IERC20 public immutable musd;
    /// Mezo MUSD Stability Pool. address(0) disables yield.
    IStabilityPool public immutable stabilityPool;

    uint256 public groupCount;

    mapping(uint256 => Group) internal groups;
    mapping(uint256 => address[]) internal members; // payout order = join order
    mapping(uint256 => mapping(address => bool)) public isMember;
    mapping(uint256 => mapping(address => uint256)) public collateralOf;
    mapping(uint256 => mapping(address => bool)) public hasDefaulted;
    mapping(uint256 => mapping(uint256 => mapping(address => bool))) public paidInRound;

    // --- Stability Pool share accounting -------------------------------------
    uint256 public totalShares;
    uint256 public accBtcPerShare; // BTC earned per share, scaled by ACC
    mapping(uint256 => uint256) public groupShares;
    mapping(uint256 => uint256) internal groupBtcDebt; // reward-debt checkpoint
    mapping(uint256 => uint256) internal groupBtcBanked; // BTC earned, not yet split between members
    /// BTC (native, 18 decimals) each member can withdraw with claimBTC().
    mapping(address => uint256) public btcOwed;

    event GroupCreated(
        uint256 indexed groupId,
        address indexed creator,
        string name,
        address token,
        uint256 contribution,
        uint8 maxMembers,
        uint64 roundDuration,
        bool earnsYield
    );
    event MemberJoined(uint256 indexed groupId, address indexed member, uint8 position);
    event GroupStarted(uint256 indexed groupId, uint64 firstDeadline);
    event Contributed(uint256 indexed groupId, uint8 indexed round, address indexed member, uint256 amount);
    event Defaulted(uint256 indexed groupId, uint8 indexed round, address indexed member, uint256 coveredFromCollateral);
    event Payout(uint256 indexed groupId, uint8 indexed round, address indexed recipient, uint256 amount);
    event CollateralReturned(uint256 indexed groupId, address indexed member, uint256 amount);
    event GroupCompleted(uint256 indexed groupId);
    event YieldDeposited(uint256 indexed groupId, uint256 musdAmount, uint256 shares);
    event YieldWithdrawn(uint256 indexed groupId, uint256 musdAmount, uint256 shares);
    event YieldUnavailable(uint256 indexed groupId);
    event BtcCredited(uint256 indexed groupId, address indexed member, uint256 amount);
    event BtcClaimed(address indexed member, uint256 amount);
    event RefundsPending(uint256 indexed groupId);

    error InvalidParams();
    error GroupNotFound();
    error NotOpen();
    error NotActive();
    error AlreadyMember();
    error NotMember();
    error AlreadyPaid();
    error RoundStillOpen();
    error YieldNotSupported();
    error StabilityPoolBusy();
    error NothingToFinalize();
    error NothingToClaim();
    error BtcTransferFailed();
    error UnexpectedBtc();

    constructor(AjoBadge _badge, IERC20 _musd, IStabilityPool _stabilityPool) {
        badge = _badge;
        musd = _musd;
        stabilityPool = _stabilityPool;
    }

    /// @dev Only the Stability Pool sends BTC here (its BTC gains).
    receive() external payable {
        if (msg.sender != address(stabilityPool) || address(stabilityPool) == address(0)) revert UnexpectedBtc();
    }

    // ---------------------------------------------------------------------
    // Actions
    // ---------------------------------------------------------------------

    /// @notice Create a new savings group. The creator still has to call join().
    /// @param earnYield Park the circle's collateral in the Mezo Stability Pool.
    /// Only for MUSD circles.
    function createGroup(
        string calldata name,
        IERC20 token,
        uint256 contribution,
        uint8 maxMembers,
        uint64 roundDuration,
        bool earnYield
    ) external returns (uint256 groupId) {
        if (
            address(token) == address(0) || contribution == 0 || maxMembers < MIN_MEMBERS
                || maxMembers > MAX_MEMBERS || roundDuration < MIN_ROUND_DURATION || bytes(name).length == 0
        ) revert InvalidParams();
        if (earnYield && !yieldSupported(token)) revert YieldNotSupported();

        groupId = ++groupCount;
        Group storage g = groups[groupId];
        g.name = name;
        g.creator = msg.sender;
        g.token = token;
        g.contribution = contribution;
        g.maxMembers = maxMembers;
        g.roundDuration = roundDuration;
        g.status = Status.Open;
        g.earnsYield = earnYield;

        emit GroupCreated(groupId, msg.sender, name, address(token), contribution, maxMembers, roundDuration, earnYield);
    }

    /// @notice Join an open group by locking one contribution as collateral.
    /// Requires prior ERC-20 approval of `contribution` to this contract.
    /// The group starts automatically when the last seat is filled; for yield
    /// circles that is when the collateral moves into the Stability Pool.
    function join(uint256 groupId) external nonReentrant {
        Group storage g = _group(groupId);
        if (g.status != Status.Open) revert NotOpen();
        if (isMember[groupId][msg.sender]) revert AlreadyMember();

        g.token.safeTransferFrom(msg.sender, address(this), g.contribution);
        collateralOf[groupId][msg.sender] = g.contribution;
        isMember[groupId][msg.sender] = true;
        members[groupId].push(msg.sender);

        emit MemberJoined(groupId, msg.sender, uint8(members[groupId].length));

        if (members[groupId].length == g.maxMembers) {
            g.status = Status.Active;
            g.roundDeadline = uint64(block.timestamp) + g.roundDuration;
            emit GroupStarted(groupId, g.roundDeadline);
            if (g.earnsYield) _vaultDeposit(groupId, g.contribution * g.maxMembers);
        }
    }

    /// @notice Pay this round's contribution. When everyone has paid, the pot
    /// is sent to this round's recipient immediately.
    function contribute(uint256 groupId) external nonReentrant {
        Group storage g = _group(groupId);
        if (g.status != Status.Active) revert NotActive();
        if (!isMember[groupId][msg.sender]) revert NotMember();
        if (paidInRound[groupId][g.currentRound][msg.sender]) revert AlreadyPaid();

        g.token.safeTransferFrom(msg.sender, address(this), g.contribution);
        paidInRound[groupId][g.currentRound][msg.sender] = true;
        g.paidCount += 1;
        g.pot += g.contribution;

        emit Contributed(groupId, g.currentRound, msg.sender, g.contribution);

        if (g.paidCount == members[groupId].length) {
            _settleRound(groupId);
        }
    }

    /// @notice After the round deadline, anyone can close the round. Members who
    /// did not pay are marked as defaulters and their collateral covers the gap.
    /// For yield circles the covered amount is withdrawn from the Stability Pool;
    /// this reverts with StabilityPoolBusy while Mezo blocks pool withdrawals
    /// (a trove is under-collateralized), and can simply be retried.
    function closeRound(uint256 groupId) external nonReentrant {
        Group storage g = _group(groupId);
        if (g.status != Status.Active) revert NotActive();
        if (block.timestamp <= g.roundDeadline) revert RoundStillOpen();

        uint256 coveredTotal;
        address[] storage m = members[groupId];
        for (uint256 i = 0; i < m.length; i++) {
            address member = m[i];
            if (!paidInRound[groupId][g.currentRound][member]) {
                uint256 available = collateralOf[groupId][member];
                uint256 covered = available >= g.contribution ? g.contribution : available;
                collateralOf[groupId][member] = available - covered;
                coveredTotal += covered;
                hasDefaulted[groupId][member] = true;
                emit Defaulted(groupId, g.currentRound, member, covered);
            }
        }

        if (g.earnsYield && coveredTotal > 0) {
            (bool ok, uint256 got) = _vaultWithdraw(groupId, coveredTotal, false);
            if (!ok) revert StabilityPoolBusy();
            // `got` can be slightly below `coveredTotal` if the pool absorbed losses.
            g.pot += got;
        } else {
            g.pot += coveredTotal;
        }

        _settleRound(groupId);
    }

    /// @notice Return collateral (and BTC earnings) for a finished yield circle
    /// whose final refund could not leave the Stability Pool at the time.
    function finalizeRefunds(uint256 groupId) external nonReentrant {
        Group storage g = _group(groupId);
        if (!g.refundPending) revert NothingToFinalize();
        (bool ok, uint256 got) = _vaultWithdraw(groupId, 0, true);
        if (!ok) revert StabilityPoolBusy();
        g.refundPending = false;
        _distribute(groupId, got);
    }

    /// @notice Withdraw the BTC you earned from yield circles.
    function claimBTC() external nonReentrant {
        uint256 amount = btcOwed[msg.sender];
        if (amount == 0) revert NothingToClaim();
        btcOwed[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert BtcTransferFailed();
        emit BtcClaimed(msg.sender, amount);
    }

    // ---------------------------------------------------------------------
    // Internal: rounds
    // ---------------------------------------------------------------------

    function _settleRound(uint256 groupId) internal {
        Group storage g = groups[groupId];
        address[] storage m = members[groupId];

        uint8 round = g.currentRound;
        address recipient = m[round];
        uint256 amount = g.pot;

        // Effects before interactions.
        g.pot = 0;
        g.paidCount = 0;
        g.currentRound = round + 1;

        bool finished = g.currentRound == m.length;
        if (finished) {
            g.status = Status.Completed;
        } else {
            g.roundDeadline = uint64(block.timestamp) + g.roundDuration;
        }

        if (amount > 0) g.token.safeTransfer(recipient, amount);
        emit Payout(groupId, round, recipient, amount);

        if (finished) _completeGroup(groupId);
    }

    function _completeGroup(uint256 groupId) internal {
        Group storage g = groups[groupId];
        address[] storage m = members[groupId];

        // Badges never depend on the Stability Pool, so they are minted first.
        for (uint256 i = 0; i < m.length; i++) {
            if (!hasDefaulted[groupId][m[i]]) {
                badge.mint(m[i], groupId, g.contribution, uint8(m.length));
            }
        }

        if (g.earnsYield) {
            (bool ok, uint256 got) = _vaultWithdraw(groupId, 0, true);
            if (ok) {
                _distribute(groupId, got);
            } else {
                // Don't block the final payout: anyone can call finalizeRefunds() later.
                g.refundPending = true;
                emit RefundsPending(groupId);
            }
        } else {
            for (uint256 i = 0; i < m.length; i++) {
                address member = m[i];
                uint256 refund = collateralOf[groupId][member];
                if (refund > 0) {
                    collateralOf[groupId][member] = 0;
                    g.token.safeTransfer(member, refund);
                    emit CollateralReturned(groupId, member, refund);
                }
            }
        }

        emit GroupCompleted(groupId);
    }

    /// @dev Split the MUSD that came back from the pool and the circle's BTC
    /// earnings between members, pro rata to the collateral each still has
    /// locked. A member whose collateral was used up by defaults gets nothing.
    function _distribute(uint256 groupId, uint256 musdAmount) internal {
        Group storage g = groups[groupId];
        address[] storage m = members[groupId];

        uint256 btcAmount = groupBtcBanked[groupId];
        groupBtcBanked[groupId] = 0;

        uint256 totalWeight;
        for (uint256 i = 0; i < m.length; i++) {
            totalWeight += collateralOf[groupId][m[i]];
        }
        // If every member's collateral was used up, split what's left equally.
        bool equal = totalWeight == 0;
        if (equal) totalWeight = m.length;

        uint256 musdLeft = musdAmount;
        uint256 btcLeft = btcAmount;
        for (uint256 i = 0; i < m.length; i++) {
            address member = m[i];
            uint256 w = equal ? 1 : collateralOf[groupId][member];
            collateralOf[groupId][member] = 0;

            // The last member takes any rounding dust.
            uint256 musdShare = i == m.length - 1 ? musdLeft : Math.mulDiv(musdAmount, w, totalWeight);
            uint256 btcShare = i == m.length - 1 ? btcLeft : Math.mulDiv(btcAmount, w, totalWeight);
            musdLeft -= musdShare;
            btcLeft -= btcShare;
            _payOut(g.token, groupId, member, musdShare, btcShare);
        }
    }

    function _payOut(IERC20 token, uint256 groupId, address member, uint256 musdShare, uint256 btcShare) internal {
        if (musdShare > 0) {
            token.safeTransfer(member, musdShare);
            emit CollateralReturned(groupId, member, musdShare);
        }
        if (btcShare > 0) {
            btcOwed[member] += btcShare;
            emit BtcCredited(groupId, member, btcShare);
        }
    }

    // ---------------------------------------------------------------------
    // Internal: Stability Pool vault
    // ---------------------------------------------------------------------

    /// @dev Spread BTC that just arrived from the pool over all current shares.
    function _accrue(uint256 balanceBefore) internal {
        uint256 gained = address(this).balance - balanceBefore;
        if (gained > 0 && totalShares > 0) accBtcPerShare += Math.mulDiv(gained, ACC, totalShares);
    }

    /// @dev Move a circle's accrued BTC into its bank. Call before its shares change.
    function _bank(uint256 groupId) internal {
        uint256 accrued = Math.mulDiv(groupShares[groupId], accBtcPerShare, ACC);
        groupBtcBanked[groupId] += accrued - groupBtcDebt[groupId];
        groupBtcDebt[groupId] = accrued;
    }

    function _setShares(uint256 groupId, uint256 newShares) internal {
        totalShares = totalShares - groupShares[groupId] + newShares;
        groupShares[groupId] = newShares;
        groupBtcDebt[groupId] = Math.mulDiv(newShares, accBtcPerShare, ACC);
    }

    function _vaultDeposit(uint256 groupId, uint256 amount) internal {
        Group storage g = groups[groupId];
        uint256 value = stabilityPool.getCompoundedMUSDDeposit(address(this));
        if (totalShares > 0 && value == 0) {
            // Existing deposit was fully used up by liquidations, so shares can't
            // be priced. Keep this circle's collateral idle instead.
            g.earnsYield = false;
            emit YieldUnavailable(groupId);
            return;
        }
        uint256 shares = totalShares == 0 ? amount : Math.mulDiv(amount, totalShares, value);

        uint256 btcBefore = address(this).balance;
        musd.forceApprove(address(stabilityPool), amount);
        try stabilityPool.provideToSP(amount) {
            _accrue(btcBefore);
            _bank(groupId);
            _setShares(groupId, groupShares[groupId] + shares);
            emit YieldDeposited(groupId, amount, shares);
        } catch {
            // Never block a circle from starting: fall back to idle collateral.
            musd.forceApprove(address(stabilityPool), 0);
            g.earnsYield = false;
            emit YieldUnavailable(groupId);
        }
    }

    /// @dev Withdraw `want` MUSD of a circle's deposit (or all of it when `all`).
    /// Returns ok = false instead of reverting when the pool refuses.
    function _vaultWithdraw(uint256 groupId, uint256 want, bool all) internal returns (bool ok, uint256 got) {
        uint256 shares = groupShares[groupId];
        if (shares == 0) return (true, 0);

        uint256 value = stabilityPool.getCompoundedMUSDDeposit(address(this));
        uint256 groupValue = Math.mulDiv(shares, value, totalShares);

        uint256 amount;
        uint256 burn;
        if (all) {
            burn = shares;
            amount = shares == totalShares ? value : groupValue; // last one out takes the dust
        } else {
            amount = want < groupValue ? want : groupValue;
            burn = value == 0 ? 0 : Math.mulDiv(amount, totalShares, value, Math.Rounding.Ceil);
            if (burn > shares) burn = shares;
        }

        uint256 btcBefore = address(this).balance;
        uint256 musdBefore = musd.balanceOf(address(this));
        // Skip the call when there is nothing to take out: after a total wipe-out
        // the pool would revert on a zero deposit and lock refunds forever.
        if (amount > 0 || stabilityPool.getDepositorCollateralGain(address(this)) > 0) {
            try stabilityPool.withdrawFromSP(amount) {}
            catch {
                return (false, 0);
            }
        }

        _accrue(btcBefore);
        _bank(groupId);
        _setShares(groupId, shares - burn);
        got = musd.balanceOf(address(this)) - musdBefore;
        emit YieldWithdrawn(groupId, got, burn);
        return (true, got);
    }

    function _group(uint256 groupId) internal view returns (Group storage g) {
        if (groupId == 0 || groupId > groupCount) revert GroupNotFound();
        g = groups[groupId];
    }

    // ---------------------------------------------------------------------
    // Views (for the frontend)
    // ---------------------------------------------------------------------

    function yieldSupported(IERC20 token) public view returns (bool) {
        return address(stabilityPool) != address(0) && address(musd) != address(0) && token == musd;
    }

    function getGroup(uint256 groupId) external view returns (Group memory) {
        return _group(groupId);
    }

    function getMembers(uint256 groupId) external view returns (address[] memory) {
        return members[groupId];
    }

    /// @notice Who receives the pot this round (address(0) if not active).
    function currentRecipient(uint256 groupId) external view returns (address) {
        Group storage g = _group(groupId);
        if (g.status != Status.Active) return address(0);
        return members[groupId][g.currentRound];
    }

    function hasPaidCurrentRound(uint256 groupId, address member) external view returns (bool) {
        Group storage g = _group(groupId);
        return paidInRound[groupId][g.currentRound][member];
    }

    /// @notice A yield circle's live position: MUSD still in the Stability Pool
    /// and BTC earned so far (paid out plus still pending in the pool).
    function yieldPosition(uint256 groupId) external view returns (uint256 musdInPool, uint256 btcEarned) {
        _group(groupId);
        uint256 shares = groupShares[groupId];
        btcEarned = groupBtcBanked[groupId];
        if (shares == 0 || totalShares == 0) return (0, btcEarned);

        musdInPool = Math.mulDiv(shares, stabilityPool.getCompoundedMUSDDeposit(address(this)), totalShares);
        btcEarned += Math.mulDiv(shares, accBtcPerShare, ACC) - groupBtcDebt[groupId];
        btcEarned += Math.mulDiv(shares, stabilityPool.getDepositorCollateralGain(address(this)), totalShares);
    }
}
