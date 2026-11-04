// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {AjoBadge} from "./AjoBadge.sol";

/// @title AjoManager
/// @notice Trustless rotating savings groups (ajo / esusu / ROSCA) on Portaldot.
/// Members lock one contribution as collateral when they join. Every round each
/// member pays the fixed contribution and the whole pot goes to one member, in
/// join order, until everyone has been paid once. If a member misses a round,
/// anyone can close the round after its deadline: the defaulter's collateral
/// covers the missed payment and they lose their completion badge.
/// Members who finish a full cycle without defaulting get their collateral back
/// and receive a soulbound AjoBadge NFT as on-chain savings history.
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
    }

    uint8 public constant MIN_MEMBERS = 2;
    uint8 public constant MAX_MEMBERS = 20;
    uint64 public constant MIN_ROUND_DURATION = 60; // 1 minute, so demos are quick

    AjoBadge public immutable badge;
    uint256 public groupCount;

    mapping(uint256 => Group) internal groups;
    mapping(uint256 => address[]) internal members; // payout order = join order
    mapping(uint256 => mapping(address => bool)) public isMember;
    mapping(uint256 => mapping(address => uint256)) public collateralOf;
    mapping(uint256 => mapping(address => bool)) public hasDefaulted;
    mapping(uint256 => mapping(uint256 => mapping(address => bool))) public paidInRound;

    event GroupCreated(
        uint256 indexed groupId,
        address indexed creator,
        string name,
        address token,
        uint256 contribution,
        uint8 maxMembers,
        uint64 roundDuration
    );
    event MemberJoined(uint256 indexed groupId, address indexed member, uint8 position);
    event GroupStarted(uint256 indexed groupId, uint64 firstDeadline);
    event Contributed(uint256 indexed groupId, uint8 indexed round, address indexed member, uint256 amount);
    event Defaulted(uint256 indexed groupId, uint8 indexed round, address indexed member, uint256 coveredFromCollateral);
    event Payout(uint256 indexed groupId, uint8 indexed round, address indexed recipient, uint256 amount);
    event CollateralReturned(uint256 indexed groupId, address indexed member, uint256 amount);
    event GroupCompleted(uint256 indexed groupId);

    error InvalidParams();
    error GroupNotFound();
    error NotOpen();
    error NotActive();
    error AlreadyMember();
    error NotMember();
    error AlreadyPaid();
    error RoundStillOpen();

    constructor(AjoBadge _badge) {
        badge = _badge;
    }

    // ---------------------------------------------------------------------
    // Actions
    // ---------------------------------------------------------------------

    /// @notice Create a new savings group. The creator still has to call join().
    function createGroup(
        string calldata name,
        IERC20 token,
        uint256 contribution,
        uint8 maxMembers,
        uint64 roundDuration
    ) external returns (uint256 groupId) {
        if (
            address(token) == address(0) || contribution == 0 || maxMembers < MIN_MEMBERS
                || maxMembers > MAX_MEMBERS || roundDuration < MIN_ROUND_DURATION || bytes(name).length == 0
        ) revert InvalidParams();

        groupId = ++groupCount;
        Group storage g = groups[groupId];
        g.name = name;
        g.creator = msg.sender;
        g.token = token;
        g.contribution = contribution;
        g.maxMembers = maxMembers;
        g.roundDuration = roundDuration;
        g.status = Status.Open;

        emit GroupCreated(groupId, msg.sender, name, address(token), contribution, maxMembers, roundDuration);
    }

    /// @notice Join an open group by locking one contribution as collateral.
    /// Requires prior ERC-20 approval of `contribution` to this contract.
    /// The group starts automatically when the last seat is filled.
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
    function closeRound(uint256 groupId) external nonReentrant {
        Group storage g = _group(groupId);
        if (g.status != Status.Active) revert NotActive();
        if (block.timestamp <= g.roundDeadline) revert RoundStillOpen();

        address[] storage m = members[groupId];
        for (uint256 i = 0; i < m.length; i++) {
            address member = m[i];
            if (!paidInRound[groupId][g.currentRound][member]) {
                uint256 available = collateralOf[groupId][member];
                uint256 covered = available >= g.contribution ? g.contribution : available;
                collateralOf[groupId][member] = available - covered;
                g.pot += covered;
                hasDefaulted[groupId][member] = true;
                emit Defaulted(groupId, g.currentRound, member, covered);
            }
        }

        _settleRound(groupId);
    }

    // ---------------------------------------------------------------------
    // Internal
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

        for (uint256 i = 0; i < m.length; i++) {
            address member = m[i];
            uint256 refund = collateralOf[groupId][member];
            if (refund > 0) {
                collateralOf[groupId][member] = 0;
                g.token.safeTransfer(member, refund);
                emit CollateralReturned(groupId, member, refund);
            }
            if (!hasDefaulted[groupId][member]) {
                badge.mint(member, groupId, g.contribution, uint8(m.length));
            }
        }

        emit GroupCompleted(groupId);
    }

    function _group(uint256 groupId) internal view returns (Group storage g) {
        if (groupId == 0 || groupId > groupCount) revert GroupNotFound();
        g = groups[groupId];
    }

    // ---------------------------------------------------------------------
    // Views (for the frontend)
    // ---------------------------------------------------------------------

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
}
