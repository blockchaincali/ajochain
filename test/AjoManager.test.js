const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("AjoChain", function () {
  const C = ethers.parseEther("10"); // contribution per round
  const DURATION = 3600; // 1 hour rounds

  async function setup() {
    const [owner, alice, bob, carol, dave] = await ethers.getSigners();

    const usd = await ethers.deployContract("MockUSDT");
    const badge = await ethers.deployContract("AjoBadge", [owner.address]);
    const ajo = await ethers.deployContract("AjoManager", [await badge.getAddress(), ethers.ZeroAddress, ethers.ZeroAddress]);
    await badge.setMinter(await ajo.getAddress());

    const ajoAddr = await ajo.getAddress();
    for (const s of [alice, bob, carol, dave]) {
      await usd.connect(s).faucet();
      await usd.connect(s).approve(ajoAddr, ethers.MaxUint256);
    }

    await ajo.connect(alice).createGroup("Lagos Traders Ajo", await usd.getAddress(), C, 3, DURATION, false);
    return { owner, alice, bob, carol, dave, usd, badge, ajo };
  }

  async function fullGroup() {
    const ctx = await setup();
    for (const s of [ctx.alice, ctx.bob, ctx.carol]) await ctx.ajo.connect(s).join(1);
    return ctx;
  }

  it("starts the group when the last seat is filled", async function () {
    const { ajo, alice, bob, carol } = await setup();
    await ajo.connect(alice).join(1);
    await ajo.connect(bob).join(1);
    expect((await ajo.getGroup(1)).status).to.equal(0n); // Open
    await expect(ajo.connect(carol).join(1)).to.emit(ajo, "GroupStarted");
    expect((await ajo.getGroup(1)).status).to.equal(1n); // Active
    expect(await ajo.getMembers(1)).to.deep.equal([alice.address, bob.address, carol.address]);
  });

  it("rejects joining a full group and double joins", async function () {
    const { ajo, alice, dave } = await fullGroup();
    await expect(ajo.connect(dave).join(1)).to.be.revertedWithCustomError(ajo, "NotOpen");

    const ctx = await setup();
    await ctx.ajo.connect(ctx.alice).join(1);
    await expect(ctx.ajo.connect(ctx.alice).join(1)).to.be.revertedWithCustomError(ctx.ajo, "AlreadyMember");
  });

  it("runs a full cycle: everyone paid once, collateral returned, badges minted", async function () {
    const { ajo, usd, badge, alice, bob, carol } = await fullGroup();
    const members = [alice, bob, carol];
    const before = await Promise.all(members.map((m) => usd.balanceOf(m.address)));

    for (let round = 0; round < 3; round++) {
      expect(await ajo.currentRecipient(1)).to.equal(members[round].address);
      for (const m of members) await ajo.connect(m).contribute(1);
    }

    const g = await ajo.getGroup(1);
    expect(g.status).to.equal(2n); // Completed

    for (let i = 0; i < 3; i++) {
      // Paid 3C + C collateral, received 3C pot + C refund => net zero.
      expect(await usd.balanceOf(members[i].address)).to.equal(before[i] + C);
      expect(await badge.balanceOf(members[i].address)).to.equal(1n);
    }
    expect(await usd.balanceOf(await ajo.getAddress())).to.equal(0n);
  });

  it("pays the recipient as soon as the last member pays", async function () {
    const { ajo, usd, alice, bob, carol } = await fullGroup();
    await ajo.connect(alice).contribute(1);
    await ajo.connect(bob).contribute(1);
    const aliceBefore = await usd.balanceOf(alice.address);
    await expect(ajo.connect(carol).contribute(1))
      .to.emit(ajo, "Payout")
      .withArgs(1n, 0n, alice.address, C * 3n);
    expect(await usd.balanceOf(alice.address)).to.equal(aliceBefore + C * 3n);
  });

  it("covers a missed payment from collateral and withholds the defaulter's badge", async function () {
    const { ajo, usd, badge, alice, bob, carol } = await fullGroup();

    await ajo.connect(alice).contribute(1);
    await ajo.connect(bob).contribute(1);
    // Carol misses round 0.
    await expect(ajo.closeRound(1)).to.be.revertedWithCustomError(ajo, "RoundStillOpen");
    await time.increase(DURATION + 1);

    const aliceBefore = await usd.balanceOf(alice.address);
    await expect(ajo.connect(bob).closeRound(1))
      .to.emit(ajo, "Defaulted")
      .withArgs(1n, 0n, carol.address, C);
    expect(await usd.balanceOf(alice.address)).to.equal(aliceBefore + C * 3n); // full pot
    expect(await ajo.hasDefaulted(1, carol.address)).to.equal(true);
    expect(await ajo.collateralOf(1, carol.address)).to.equal(0n);

    // Rounds 1 and 2: everyone pays.
    for (let r = 1; r < 3; r++) {
      for (const m of [alice, bob, carol]) await ajo.connect(m).contribute(1);
    }

    expect((await ajo.getGroup(1)).status).to.equal(2n);
    expect(await badge.balanceOf(alice.address)).to.equal(1n);
    expect(await badge.balanceOf(bob.address)).to.equal(1n);
    expect(await badge.balanceOf(carol.address)).to.equal(0n);
  });

  it("blocks double contributions and non-members", async function () {
    const { ajo, alice, dave } = await fullGroup();
    await ajo.connect(alice).contribute(1);
    await expect(ajo.connect(alice).contribute(1)).to.be.revertedWithCustomError(ajo, "AlreadyPaid");
    await expect(ajo.connect(dave).contribute(1)).to.be.revertedWithCustomError(ajo, "NotMember");
  });

  it("makes badges soulbound and only mintable by the manager", async function () {
    const { ajo, badge, alice, bob, carol } = await fullGroup();
    for (let r = 0; r < 3; r++) for (const m of [alice, bob, carol]) await ajo.connect(m).contribute(1);

    await expect(
      badge.connect(alice).transferFrom(alice.address, bob.address, 1)
    ).to.be.revertedWithCustomError(badge, "Soulbound");
    await expect(badge.connect(alice).mint(alice.address, 1, C, 3)).to.be.revertedWithCustomError(
      badge,
      "NotMinter"
    );
  });

  it("validates group parameters", async function () {
    const { ajo, usd, alice } = await setup();
    const token = await usd.getAddress();
    await expect(ajo.connect(alice).createGroup("x", token, C, 1, DURATION, false)).to.be.revertedWithCustomError(
      ajo,
      "InvalidParams"
    );
    await expect(ajo.connect(alice).createGroup("x", token, 0, 3, DURATION, false)).to.be.revertedWithCustomError(
      ajo,
      "InvalidParams"
    );
    await expect(ajo.connect(alice).createGroup("x", token, C, 3, 10, false)).to.be.revertedWithCustomError(
      ajo,
      "InvalidParams"
    );
  });
});
