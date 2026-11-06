// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AjoManager} from "../../contracts/AjoManager.sol";
import {AjoBadge} from "../../contracts/AjoBadge.sol";
import {MockUSDT} from "../../contracts/MockUSDT.sol";
import {MockStabilityPool} from "../../contracts/mocks/MockStabilityPool.sol";
import {IStabilityPool} from "../../contracts/interfaces/IStabilityPool.sol";

/// Minimal cheatcode interface, so the tests need no forge-std install.
interface Vm {
    function prank(address) external;
    function warp(uint256) external;
    function deal(address, uint256) external;
    function expectRevert(bytes4) external;
    function expectRevert() external;
}

/// A pool whose deposits always fail, to test the idle-collateral fallback.
contract RevertingPool {
    function provideToSP(uint256) external pure {
        revert("nope");
    }

    function withdrawFromSP(uint256) external pure {
        revert("nope");
    }

    function getCompoundedMUSDDeposit(address) external pure returns (uint256) {
        return 0;
    }

    function getDepositorCollateralGain(address) external pure returns (uint256) {
        return 0;
    }
}

contract AjoManagerMezoTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 constant C = 100 ether; // contribution per round (MUSD, 18 decimals)
    uint64 constant DUR = 3600;

    MockUSDT musd; // stands in for MUSD
    MockUSDT mezo; // stands in for MEZO (no yield)
    MockStabilityPool sp;
    AjoBadge badge;
    AjoManager ajo;

    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address carol = address(0xCA201);
    address dave = address(0xDA7E);
    address erin = address(0xE41);
    address frank = address(0xF4A2C);

    function setUp() public {
        musd = new MockUSDT();
        mezo = new MockUSDT();
        sp = new MockStabilityPool(IERC20(address(musd)));
        badge = new AjoBadge(address(this));
        ajo = new AjoManager(badge, IERC20(address(musd)), IStabilityPool(address(sp)));
        badge.setMinter(address(ajo));
        vm.deal(address(this), 100 ether);

        address[6] memory people = [alice, bob, carol, dave, erin, frank];
        for (uint256 i = 0; i < people.length; i++) {
            vm.prank(people[i]);
            musd.faucet();
            vm.prank(people[i]);
            musd.approve(address(ajo), type(uint256).max);
            vm.prank(people[i]);
            mezo.faucet();
            vm.prank(people[i]);
            mezo.approve(address(ajo), type(uint256).max);
        }
    }

    // ------------------------------------------------------------------ helpers

    function eq(uint256 a, uint256 b, string memory what) internal pure {
        if (a != b) revert(string.concat(what, ": ", toString(a), " != ", toString(b)));
    }

    /// Share maths rounds down (in the pool's favour) by a few wei.
    function near(uint256 a, uint256 b, string memory what) internal pure {
        uint256 d = a > b ? a - b : b - a;
        if (d > 10) revert(string.concat(what, ": ", toString(a), " !~ ", toString(b)));
    }

    function ok(bool c, string memory what) internal pure {
        if (!c) revert(what);
    }

    function toString(uint256 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        bytes memory b;
        while (v > 0) {
            b = abi.encodePacked(bytes1(uint8(48 + (v % 10))), b);
            v /= 10;
        }
        return string(b);
    }

    function _create(IERC20 token, bool yield, address creator) internal returns (uint256 id) {
        vm.prank(creator);
        id = ajo.createGroup("Lagos Traders Ajo", token, C, 3, DUR, yield);
    }

    function _joinAll(uint256 id, address a, address b, address c) internal {
        vm.prank(a);
        ajo.join(id);
        vm.prank(b);
        ajo.join(id);
        vm.prank(c);
        ajo.join(id);
    }

    function _payRound(uint256 id, address a, address b, address c) internal {
        vm.prank(a);
        ajo.contribute(id);
        vm.prank(b);
        ajo.contribute(id);
        vm.prank(c);
        ajo.contribute(id);
    }

    // -------------------------------------------------------------------- tests

    function test_plainCircleInMezoTokenWorksWithoutYield() public {
        uint256 id = _create(IERC20(address(mezo)), false, alice);
        _joinAll(id, alice, bob, carol);
        eq(mezo.balanceOf(address(ajo)), 3 * C, "collateral held in contract");
        for (uint256 r = 0; r < 3; r++) _payRound(id, alice, bob, carol);

        // Everyone paid 3C, received a 3C pot and got collateral back: net zero.
        eq(mezo.balanceOf(alice), 1000 ether, "alice");
        eq(mezo.balanceOf(carol), 1000 ether, "carol");
        eq(mezo.balanceOf(address(ajo)), 0, "contract empty");
        eq(badge.balanceOf(bob), 1, "badge");
    }

    function test_yieldOnlyForMusd() public {
        vm.expectRevert(AjoManager.YieldNotSupported.selector);
        _create(IERC20(address(mezo)), true, alice);

        AjoManager noPool = new AjoManager(badge, IERC20(address(0)), IStabilityPool(address(0)));
        vm.expectRevert(AjoManager.YieldNotSupported.selector);
        noPool.createGroup("x", IERC20(address(musd)), C, 3, DUR, true);
    }

    function test_collateralMovesIntoStabilityPoolOnStart() public {
        uint256 id = _create(IERC20(address(musd)), true, alice);
        vm.prank(alice);
        ajo.join(id);
        vm.prank(bob);
        ajo.join(id);
        eq(sp.deposits(address(ajo)), 0, "nothing deposited while open");

        vm.prank(carol);
        ajo.join(id);
        eq(sp.deposits(address(ajo)), 3 * C, "deposited on start");
        eq(musd.balanceOf(address(ajo)), 0, "no idle MUSD");
        (uint256 inPool,) = ajo.yieldPosition(id);
        eq(inPool, 3 * C, "position");
    }

    function test_fullYieldCycleReturnsCollateralAndBtc() public {
        uint256 id = _create(IERC20(address(musd)), true, alice);
        _joinAll(id, alice, bob, carol);

        _payRound(id, alice, bob, carol);
        // A liquidation: the pool burns 30 MUSD of deposits and pays 0.003 BTC.
        sp.liquidate{value: 0.003 ether}(30 ether);
        (uint256 inPool, uint256 btc) = ajo.yieldPosition(id);
        eq(inPool, 270 ether, "position after liquidation");
        eq(btc, 0.003 ether, "btc pending");

        _payRound(id, alice, bob, carol);
        _payRound(id, alice, bob, carol);

        // Each member gets 90 MUSD back (100 - 10 absorbed) and 0.001 BTC.
        eq(musd.balanceOf(alice), 990 ether, "alice musd");
        eq(musd.balanceOf(carol), 990 ether, "carol musd");
        eq(ajo.btcOwed(bob), 0.001 ether, "bob btc");
        eq(badge.balanceOf(alice), 1, "badge");
        eq(ajo.totalShares(), 0, "shares cleared");

        vm.prank(bob);
        ajo.claimBTC();
        eq(bob.balance, 0.001 ether, "bob claimed");
        eq(ajo.btcOwed(bob), 0, "owed cleared");
        vm.expectRevert(AjoManager.NothingToClaim.selector);
        vm.prank(bob);
        ajo.claimBTC();
    }

    function test_twoCirclesSplitPoolFairly() public {
        uint256 g1 = _create(IERC20(address(musd)), true, alice);
        _joinAll(g1, alice, bob, carol); // 300 MUSD in

        // Liquidation 1 only affects circle 1.
        sp.liquidate{value: 0.006 ether}(30 ether); // g1 now 270

        uint256 g2 = _create(IERC20(address(musd)), true, dave);
        _joinAll(g2, dave, erin, frank); // 300 MUSD in, pool total 570

        // Liquidation 2 is shared 270:300.
        sp.liquidate{value: 0.0057 ether}(57 ether);

        (uint256 v1, uint256 b1) = ajo.yieldPosition(g1);
        (uint256 v2, uint256 b2) = ajo.yieldPosition(g2);
        near(v1, 243 ether, "g1 value"); // 270 - 27
        near(v2, 270 ether, "g2 value"); // 300 - 30
        near(b1, 0.006 ether + 0.0027 ether, "g1 btc");
        near(b2, 0.003 ether, "g2 btc");

        // Finish circle 2 first; circle 1 must keep its position untouched.
        for (uint256 r = 0; r < 3; r++) _payRound(g2, dave, erin, frank);
        near(musd.balanceOf(dave), 990 ether, "dave");
        near(ajo.btcOwed(frank), 0.001 ether, "frank btc");
        (v1, b1) = ajo.yieldPosition(g1);
        near(v1, 243 ether, "g1 unchanged");
        near(b1, 0.0087 ether, "g1 btc unchanged");

        for (uint256 r = 0; r < 3; r++) _payRound(g1, alice, bob, carol);
        near(musd.balanceOf(alice), 981 ether, "alice"); // 1000 - 19
        near(ajo.btcOwed(alice), 0.0029 ether, "alice btc");
        near(sp.deposits(address(ajo)), 0, "pool emptied");
    }

    function test_defaultIsCoveredFromPool() public {
        uint256 id = _create(IERC20(address(musd)), true, alice);
        _joinAll(id, alice, bob, carol);

        // Round 0: carol doesn't pay.
        vm.prank(alice);
        ajo.contribute(id);
        vm.prank(bob);
        ajo.contribute(id);
        vm.warp(block.timestamp + DUR + 1);
        ajo.closeRound(id);

        // Alice still received a full pot of 3C.
        eq(musd.balanceOf(alice), 1000 ether - C - C + 3 * C, "alice got full pot");
        eq(sp.deposits(address(ajo)), 2 * C, "carol's collateral left the pool");
        ok(ajo.hasDefaulted(id, carol), "carol marked");

        _payRound(id, alice, bob, carol);
        _payRound(id, alice, bob, carol);

        eq(badge.balanceOf(carol), 0, "no badge for defaulter");
        eq(badge.balanceOf(bob), 1, "bob badge");
        eq(musd.balanceOf(bob), 1000 ether, "bob whole again");
        // Carol: paid 1C collateral + 2C rounds, received 3C pot, nothing refunded.
        eq(musd.balanceOf(carol), 1000 ether, "carol net zero (lost collateral, got pot)");
        eq(musd.balanceOf(address(ajo)), 0, "no MUSD stuck");
    }

    function test_closeRoundWaitsWhilePoolIsLocked() public {
        uint256 id = _create(IERC20(address(musd)), true, alice);
        _joinAll(id, alice, bob, carol);
        vm.warp(block.timestamp + DUR + 1);

        sp.setBlocked(true);
        vm.expectRevert(AjoManager.StabilityPoolBusy.selector);
        ajo.closeRound(id);

        sp.setBlocked(false);
        ajo.closeRound(id);
        eq(musd.balanceOf(alice), 1000 ether - C + 3 * C, "alice paid from 3 collaterals");
    }

    function test_finalPayoutNeverBlockedByPool() public {
        uint256 id = _create(IERC20(address(musd)), true, alice);
        _joinAll(id, alice, bob, carol);
        _payRound(id, alice, bob, carol);
        _payRound(id, alice, bob, carol);
        sp.liquidate{value: 0.003 ether}(0);

        sp.setBlocked(true);
        _payRound(id, alice, bob, carol); // last round still pays carol
        AjoManager.Group memory g = ajo.getGroup(id);
        ok(g.refundPending, "refund pending");
        ok(uint8(g.status) == 2, "completed");
        eq(musd.balanceOf(carol), 1000 ether - 4 * C + 3 * C, "carol got pot, collateral still out");
        eq(badge.balanceOf(carol), 1, "badge minted anyway");

        vm.expectRevert(AjoManager.StabilityPoolBusy.selector);
        ajo.finalizeRefunds(id);

        sp.setBlocked(false);
        ajo.finalizeRefunds(id);
        eq(musd.balanceOf(carol), 1000 ether, "carol refunded");
        eq(ajo.btcOwed(alice), 0.001 ether, "btc credited");
        vm.expectRevert(AjoManager.NothingToFinalize.selector);
        ajo.finalizeRefunds(id);
    }

    function test_poolFailureFallsBackToIdleCollateral() public {
        RevertingPool bad = new RevertingPool();
        AjoManager m = new AjoManager(badge, IERC20(address(musd)), IStabilityPool(address(bad)));
        vm.prank(alice);
        uint256 id = m.createGroup("x", IERC20(address(musd)), C, 2, DUR, true);
        vm.prank(alice);
        musd.approve(address(m), type(uint256).max);
        vm.prank(bob);
        musd.approve(address(m), type(uint256).max);
        vm.prank(alice);
        m.join(id);
        vm.prank(bob);
        m.join(id);

        AjoManager.Group memory g = m.getGroup(id);
        ok(!g.earnsYield, "fell back to idle");
        ok(uint8(g.status) == 1, "circle still started");
        eq(musd.balanceOf(address(m)), 2 * C, "collateral held idle");
    }

    function test_totalWipeOutStillCompletesAndPaysBtc() public {
        uint256 id = _create(IERC20(address(musd)), true, alice);
        _joinAll(id, alice, bob, carol);
        // The pool absorbs a liquidation that uses up the whole deposit.
        sp.liquidate{value: 0.0033 ether}(300 ether);
        for (uint256 r = 0; r < 3; r++) _payRound(id, alice, bob, carol);

        AjoManager.Group memory g = ajo.getGroup(id);
        ok(!g.refundPending, "not stuck");
        eq(musd.balanceOf(alice), 900 ether, "MUSD collateral gone");
        eq(ajo.btcOwed(alice), 0.0011 ether, "but BTC paid instead");

        // A later circle starts with idle collateral rather than unpriceable shares.
        uint256 id2 = _create(IERC20(address(musd)), true, dave);
        _joinAll(id2, dave, erin, frank);
        eq(ajo.totalShares(), 300 ether, "fresh shares after wipe-out");
    }

    function test_rejectsStrayBtc() public {
        (bool sent,) = address(ajo).call{value: 1 ether}("");
        ok(!sent, "stray BTC rejected");
    }

    receive() external payable {}
}
