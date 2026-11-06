import { ethers } from "https://cdn.jsdelivr.net/npm/ethers@6.13.4/dist/ethers.min.js";
import { CONFIG } from "./config.js";

// ---------------------------------------------------------------------------
// ABIs (human-readable). Custom errors are listed so reverts decode to names.
// ---------------------------------------------------------------------------
const MANAGER_ERRORS = [
  "error InvalidParams()", "error GroupNotFound()", "error NotOpen()", "error NotActive()",
  "error AlreadyMember()", "error NotMember()", "error AlreadyPaid()", "error RoundStillOpen()",
  "error YieldNotSupported()", "error StabilityPoolBusy()", "error NothingToFinalize()", "error NothingToClaim()",
  "error BtcTransferFailed()",
];
const ERC20_ERRORS = [
  "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
  "error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)",
];
const MANAGER_ABI = [
  ...MANAGER_ERRORS,
  ...ERC20_ERRORS, // token transfers happen inside join/contribute, so their errors bubble up here
  "function groupCount() view returns (uint256)",
  "function createGroup(string name, address token, uint256 contribution, uint8 maxMembers, uint64 roundDuration, bool earnYield) returns (uint256)",
  "function join(uint256 groupId)",
  "function contribute(uint256 groupId)",
  "function closeRound(uint256 groupId)",
  "function finalizeRefunds(uint256 groupId)",
  "function claimBTC()",
  "function btcOwed(address) view returns (uint256)",
  "function yieldPosition(uint256 groupId) view returns (uint256 musdInPool, uint256 btcEarned)",
  "function getGroup(uint256 groupId) view returns (tuple(string name, address creator, address token, uint256 contribution, uint64 roundDuration, uint64 roundDeadline, uint8 maxMembers, uint8 currentRound, uint8 paidCount, uint8 status, uint256 pot, bool earnsYield, bool refundPending))",
  "function getMembers(uint256 groupId) view returns (address[])",
  "function hasDefaulted(uint256, address) view returns (bool)",
  "function paidInRound(uint256, uint256, address) view returns (bool)",
];
const TOKEN_ABI = [
  ...ERC20_ERRORS,
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address, address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
  "function faucet()",
];
const BADGE_ABI = ["function balanceOf(address) view returns (uint256)"];
// Mezo MUSD system contracts, used to detect and clear a blocked Stability Pool.
const SP_ABI = ["function withdrawFromSP(uint256)"];
const TM_ABI = [
  "function getCurrentICR(address, uint256) view returns (uint256)",
  "function batchLiquidateTroves(address[])",
];
const SORTED_ABI = ["function getLast() view returns (address)", "function getPrev(address) view returns (address)"];
const FEED_ABI = ["function fetchPrice() view returns (uint256)"];
const MCR = 11n * 10n ** 17n; // 110%: troves below this block Stability Pool withdrawals
const canUnblock = Boolean(CONFIG.contracts.TroveManager && CONFIG.contracts.SortedTroves && CONFIG.contracts.PriceFeed);
let poolBlocked = false; // last known Stability Pool state

const FRIENDLY = {
  InvalidParams: "Check the form: 2–20 members, a contribution above 0, and rounds of at least 1 minute.",
  GroupNotFound: "That circle doesn't exist on this network.",
  NotOpen: "This circle is already full.",
  NotActive: "This circle isn't running right now.",
  AlreadyMember: "You're already in this circle.",
  NotMember: "Only members of this circle can pay into it.",
  AlreadyPaid: "You've already paid for this round.",
  RoundStillOpen: "The round can only be closed after its deadline.",
  YieldNotSupported: "Only MUSD circles can earn in the Mezo Stability Pool.",
  StabilityPoolBusy: "Mezo's Stability Pool is paused until an under-collateralized loan is liquidated. Press “Unblock pool” on the circle, then try again.",
  NothingToFinalize: "This circle's collateral has already been returned.",
  NothingToClaim: "You have no BTC earnings to claim yet.",
  BtcTransferFailed: "Sending your BTC failed. Try again from a regular wallet address.",
  ERC20InsufficientBalance: "Your token balance is too low for this.",
  ERC20InsufficientAllowance: "Token spending wasn't approved. Try again and approve in your wallet.",
};

const isLocal = CONFIG.chainId === 31337;
const isMezo = CONFIG.chainId === 31611 || CONFIG.chainId === 31612;
const gasSymbol = CONFIG.nativeSymbol || "POT";

// Savings tokens. Older configs had a single MockUSDT; keep them working.
const TOKENS = (CONFIG.tokens && CONFIG.tokens.length)
  ? CONFIG.tokens
  : [{ symbol: "aUSD", address: CONFIG.contracts.MockUSDT, yield: false, faucet: true }];
const MAIN = TOKENS[0];
const tokenInfo = (addr) => TOKENS.find((t) => same(t.address, addr)) || { symbol: "tokens", address: addr };

// ---------------------------------------------------------------------------
// State + helpers
// ---------------------------------------------------------------------------
let provider, signer, me, manager, badge;
const tokenC = {}; // address(lowercase) -> ethers.Contract
let refreshTimer;
let filter = "all";
let cache = []; // rendered circle data

const $ = (id) => document.getElementById(id);
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const fmt = (v, d = 2) => Number(ethers.formatUnits(v, 18)).toLocaleString(undefined, { maximumFractionDigits: d });
const same = (a, b) => a.toLowerCase() === b.toLowerCase();
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function toast(msg, kind = "") {
  const t = $("toast");
  t.textContent = msg;
  t.className = `toast ${kind}`;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add("hidden"), kind === "error" ? 8000 : 4500);
}

function log(msg, hash) {
  const li = document.createElement("li");
  li.innerHTML = `<time>${new Date().toLocaleTimeString()}</time><div>${esc(msg)}${hash ? `<span class="hash">${hash}</span>` : ""}</div>`;
  $("log").prepend(li);
  $("logCount").textContent = $("log").children.length;
}

function explain(e) {
  // 1. Contract custom errors (decoded via the ABI).
  const name = e?.revert?.name;
  if (name && FRIENDLY[name]) return FRIENDLY[name];
  const data = [e?.data, e?.info?.error?.data, e?.error?.data].find((d) => typeof d === "string") || "";
  if (data.startsWith("0x874d383c")) return FRIENDLY.StabilityPoolBusy; // StabilityPoolBusy()
  if (name) return name;

  // 2. Wallet / node errors, which ethers often wraps as "could not coalesce error".
  const raw = [
    e?.shortMessage, e?.reason, e?.info?.error?.message, e?.info?.error?.data?.message,
    e?.error?.message, e?.data?.message, e?.message,
  ].filter(Boolean).join(" | ");

  if (e?.code === "ACTION_REJECTED" || /user rejected|denied/i.test(raw)) return "You cancelled the transaction in your wallet.";
  if (/insufficient funds/i.test(raw)) return `Your wallet has no ${gasSymbol} to pay gas on this network.`;
  if (/nonce/i.test(raw)) return "Wallet nonce is out of sync. In MetaMask: Settings › Advanced › Clear activity tab data, then retry.";
  if (/could not coalesce/i.test(raw)) {
    return isLocal
      ? "The local node rejected the transaction. Make sure you're using an imported Hardhat test account and that `npm run node` is still running."
      : `The network rejected the transaction. Check you have ${gasSymbol} for gas and are on ${CONFIG.chainName}.`;
  }
  return e?.shortMessage || e?.reason || e?.message || String(e);
}

// ---------------------------------------------------------------------------
// Hero ring animation (runs without a wallet)
// ---------------------------------------------------------------------------
function heroRing() {
  const names = ["Ada", "Tunde", "Ngozi", "Emeka", "Bisi", "Yusuf"];
  const g = $("ringMembers");
  const R = 140, C = 200;
  const pos = names.map((_, i) => {
    const a = (-90 + i * (360 / names.length)) * (Math.PI / 180);
    return [C + R * Math.cos(a), C + R * Math.sin(a), a];
  });
  g.innerHTML = names.map((n, i) => {
    const [x, y, a] = pos[i];
    const lx = C + (R + 46) * Math.cos(a), ly = C + (R + 46) * Math.sin(a) + 4;
    return `<g class="ring-member" data-i="${i}">
        <circle cx="${x}" cy="${y}" r="22"></circle>
        <text x="${x}" y="${y + 4.5}" text-anchor="middle">${n[0]}</text>
      </g>
      <text class="ring-name" x="${lx}" y="${ly}" text-anchor="middle">${n}</text>`;
  }).join("");

  const pot = $("ringPot");
  const members = [...g.querySelectorAll(".ring-member")];
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let i = 0;

  function step() {
    const [x, y] = pos[i];
    // The pot sits just inside the ring, next to this round's recipient.
    const px = C + (x - C) * 0.55, py = C + (y - C) * 0.55;
    pot.setAttribute("transform", `translate(${px} ${py})`);
    members.forEach((m, k) => {
      m.classList.toggle("now", k === i);
      m.classList.toggle("paid", k < i);
    });
    $("ringCaption").textContent = `Round ${i + 1} of ${names.length}: ${names[i]} receives 60 ${MAIN.symbol}`;
    i = (i + 1) % names.length;
  }
  step();
  if (!reduce) setInterval(step, 2400);
}

// ---------------------------------------------------------------------------
// Wallet
// ---------------------------------------------------------------------------
async function ensureChain() {
  const hexId = "0x" + CONFIG.chainId.toString(16);
  try {
    await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hexId }] });
  } catch (e) {
    if (e.code === 4902 || /Unrecognized chain|not been added/i.test(e.message || "")) {
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: hexId,
          chainName: CONFIG.chainName,
          rpcUrls: [CONFIG.rpcUrl],
          nativeCurrency: { name: gasSymbol, symbol: gasSymbol, decimals: 18 },
          ...(CONFIG.explorer ? { blockExplorerUrls: [CONFIG.explorer] } : {}),
        }],
      });
    } else throw e;
  }
}

async function connect() {
  if (!window.ethereum) return toast("No wallet found. Install MetaMask, then reload this page.", "error");
  const c = CONFIG.contracts;
  if (!c.AjoManager || !c.AjoBadge) {
    return toast("Contract addresses are missing. Run the deploy script first.", "error");
  }
  try {
    await window.ethereum.request({ method: "eth_requestAccounts" });
    await ensureChain();
    provider = new ethers.BrowserProvider(window.ethereum);
    signer = await provider.getSigner();
    me = await signer.getAddress();
    manager = new ethers.Contract(c.AjoManager, MANAGER_ABI, signer);
    for (const t of TOKENS) tokenC[t.address.toLowerCase()] = new ethers.Contract(t.address, TOKEN_ABI, signer);
    badge = new ethers.Contract(c.AjoBadge, BADGE_ABI, signer);

    const net = await provider.getNetwork();
    const onRightChain = Number(net.chainId) === CONFIG.chainId;
    $("netPill").textContent = onRightChain ? CONFIG.chainName : "Wrong network";
    $("netPill").classList.toggle("bad", !onRightChain);
    $("netPill").classList.remove("hidden");

    $("connectBtn").classList.add("hidden");
    $("acctBtn").textContent = short(me);
    $("acctBtn").classList.remove("hidden");
    $("gate").classList.add("hidden");
    $("appBody").classList.remove("hidden");
    $("heroCta").textContent = "Go to your circles";

    await refresh();
    clearInterval(refreshTimer);
    refreshTimer = setInterval(refresh, 15000);
  } catch (e) {
    toast(explain(e), "error");
  }
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------
async function hasGas() {
  const bal = await provider.getBalance(me);
  if (bal > 0n) return true;
  showGasWarning(true);
  toast(`You need ${gasSymbol} for gas before you can do this.`, "error");
  return false;
}

async function send(label, done, fn) {
  try {
    if (!(await hasGas())) return false;
    toast(`${label}: confirm in your wallet`);
    const tx = await fn();
    toast(`${label}: waiting for the network`);
    await tx.wait();
    log(done, tx.hash);
    toast(done, "ok");
    await refresh();
    return true;
  } catch (e) {
    console.error(e);
    toast(explain(e), "error");
    return false;
  }
}

async function ensureAllowance(tokenAddr, amount) {
  const t = tokenInfo(tokenAddr);
  const token = tokenC[tokenAddr.toLowerCase()] || new ethers.Contract(tokenAddr, TOKEN_ABI, signer);
  const bal = await token.balanceOf(me);
  if (bal < amount) {
    const how = t.faucet ? `Use “Get 1,000 ${t.symbol}” first.`
      : t.symbol === "MUSD" ? "Borrow MUSD against test BTC in the Mezo testnet app first."
      : `Get some ${t.symbol} from the Mezo faucet first.`;
    toast(`You need ${fmt(amount)} ${t.symbol} but have ${fmt(bal)}. ${how}`, "error");
    return false;
  }
  const current = await token.allowance(me, CONFIG.contracts.AjoManager);
  if (current >= amount) return true;
  return send(`Approve ${t.symbol}`, `Approved ${t.symbol} for AjoChain`, () =>
    token.approve(CONFIG.contracts.AjoManager, ethers.MaxUint256)
  );
}

async function onCreate(ev) {
  ev.preventDefault();
  const form = ev.target;
  const f = new FormData(form);
  const name = String(f.get("name")).trim();
  const amount = ethers.parseUnits(String(f.get("amount")), 18);
  const members = Number(f.get("members"));
  const seconds = Math.round(Number(f.get("minutes")) * 60);
  const t = TOKENS.find((x) => x.address === f.get("token")) || MAIN;
  const earn = Boolean(t.yield && f.get("earn"));
  const btn = form.querySelector("button[type=submit]");
  btn.disabled = true;
  const ok = await send(`Create “${name}”`, `Created circle “${name}”`, () =>
    manager.createGroup(name, t.address, amount, members, seconds, earn)
  );
  btn.disabled = false;
  if (ok) { form.reset(); updateFormSum(); }
}

const onJoin = async (id, g) => (await ensureAllowance(g.token, g.contribution)) && send(`Join circle #${id}`, `Joined circle #${id}`, () => manager.join(id));
const onPay = async (id, g) => (await ensureAllowance(g.token, g.contribution)) && send(`Pay circle #${id}`, `Paid this round in circle #${id}`, () => manager.contribute(id));
const POOL_BUSY_MSG = "Mezo's Stability Pool is paused: a Mezo loan has dropped below 110% collateral and hasn't been liquidated yet. Press “Unblock pool” to liquidate it (you earn Mezo's liquidation reward), then try again.";

// Yield circles need the pool open; check first so the wallet never shows a
// failing transaction.
async function poolGate(g) {
  if (!g.earnsYield) return true;
  poolBlocked = await checkPoolBlocked();
  if (!poolBlocked) return true;
  renderCircles();
  toast(canUnblock ? POOL_BUSY_MSG : "Mezo's Stability Pool is paused while a loan waits to be liquidated. Try again in a few minutes.", "error");
  return false;
}
const onClose = async (id, g) => (await poolGate(g)) && send(`Close round in #${id}`, `Closed the round in circle #${id}`, () => manager.closeRound(id));
const onFinalize = async (id, g) => (await poolGate(g)) && send(`Return collateral in #${id}`, `Collateral returned in circle #${id}`, () => manager.finalizeRefunds(id));

/// True if Mezo's Stability Pool currently refuses withdrawals (a trove is below MCR).
async function checkPoolBlocked() {
  const sp = CONFIG.contracts.StabilityPool;
  if (!sp || sp === ethers.ZeroAddress) return false;
  try {
    const data = new ethers.Interface(SP_ABI).encodeFunctionData("withdrawFromSP", [1n]);
    await provider.call({ to: sp, from: CONFIG.contracts.AjoManager, data });
    return false;
  } catch (e) {
    const raw = [e?.reason, e?.shortMessage, e?.info?.error?.message, e?.message].filter(Boolean).join(" ");
    return /ICR < MCR/.test(raw);
  }
}

/// Find troves below 110% collateral, lowest first (at most `max`).
async function findBadTroves(max = 10) {
  const tm = new ethers.Contract(CONFIG.contracts.TroveManager, TM_ABI, provider);
  const sorted = new ethers.Contract(CONFIG.contracts.SortedTroves, SORTED_ABI, provider);
  const price = await new ethers.Contract(CONFIG.contracts.PriceFeed, FEED_ABI, provider).fetchPrice();
  const bad = [];
  let cur = await sorted.getLast();
  while (bad.length < max && cur !== ethers.ZeroAddress) {
    if ((await tm.getCurrentICR(cur, price)) >= MCR) break;
    bad.push(cur);
    cur = await sorted.getPrev(cur);
  }
  return bad;
}

/// Liquidate the troves that block the pool. Permissionless: anyone can do
/// it, and Mezo pays the liquidator a reward in MUSD and BTC.
async function onUnblock() {
  try {
    toast("Looking for Mezo loans below 110% collateral…");
    const bad = await findBadTroves();
    if (bad.length === 0) {
      poolBlocked = await checkPoolBlocked();
      toast(poolBlocked ? "Still paused. Try again in a moment." : "The Stability Pool is open again.", poolBlocked ? "error" : "ok");
      return refresh();
    }
    const tm = new ethers.Contract(CONFIG.contracts.TroveManager, TM_ABI, signer);
    const ok = await send(
      "Unblock pool",
      `Liquidated ${bad.length} Mezo loan${bad.length === 1 ? "" : "s"}. The pool is open and this circle earned from it.`,
      () => tm.batchLiquidateTroves(bad)
    );
    if (ok) poolBlocked = await checkPoolBlocked();
  } catch (e) {
    console.error(e);
    toast(explain(e), "error");
  }
}
const onClaim = () => send("Claim BTC earnings", "Claimed your BTC earnings", () => manager.claimBTC());

// ---------------------------------------------------------------------------
// Data + rendering
// ---------------------------------------------------------------------------
function showGasWarning(show) {
  const w = $("gasWarn");
  if (!show) return w.classList.add("hidden");
  w.innerHTML = isLocal
    ? `<b>This wallet has no ETH on Hardhat Local, so it can't send transactions.</b><br>
       In MetaMask choose <b>Add account › Import account</b> and paste the private key of <b>Account #0</b>
       printed by <code>npm run node</code>, then switch to it.`
    : CONFIG.gasFaucet
      ? `<b>This wallet has no ${gasSymbol} for gas.</b><br>
       Get free testnet ${gasSymbol} from the <a href="${CONFIG.gasFaucet}" target="_blank" rel="noopener">Mezo faucet</a>, then refresh this page.`
      : `<b>This wallet has no ${gasSymbol} for gas.</b><br>
       Request testnet ${gasSymbol} from the network's faucet, then refresh this page.`;
  w.classList.remove("hidden");
}

async function refresh() {
  if (!manager) return;
  try {
    const [bal, gas, nBadges, count, owed] = await Promise.all([
      tokenC[MAIN.address.toLowerCase()].balanceOf(me), provider.getBalance(me), badge.balanceOf(me),
      manager.groupCount(), manager.btcOwed(me).catch(() => 0n),
    ]);
    $("statBal").textContent = fmt(bal);
    $("statEarn").textContent = fmt(owed, 6);
    $("claimBtn").classList.toggle("hidden", owed === 0n);
    $("statGasLabel").textContent = `${isLocal ? "ETH" : gasSymbol} for gas`;
    $("statGas").textContent = fmt(gas, 4);
    $("statBadges").textContent = nBadges.toString();
    showGasWarning(gas === 0n);

    const ids = [];
    for (let i = Number(count); i >= 1; i--) ids.push(i);
    cache = await Promise.all(ids.map(loadCircle));
    const needsPool = cache.some((c) => c.g.earnsYield && (c.late || c.g.refundPending));
    poolBlocked = needsPool ? await checkPoolBlocked() : false;
    $("statJoined").textContent = cache.filter((c) => c.amMember).length;
    renderCircles();
  } catch (e) {
    console.error(e);
    toast(`Couldn't load circles: ${explain(e)}`, "error");
  }
}

async function loadCircle(id) {
  const [g, list] = await Promise.all([manager.getGroup(id), manager.getMembers(id)]);
  const pos = g.earnsYield ? await manager.yieldPosition(id).catch(() => null) : null;
  const status = ["open", "active", "done"][Number(g.status)];
  const round = Number(g.currentRound);
  const members = await Promise.all(list.map(async (addr, i) => {
    const [paid, missed] = await Promise.all([
      status === "active" ? manager.paidInRound(id, round, addr) : false,
      manager.hasDefaulted(id, addr),
    ]);
    return { addr, i, paid, missed, isMe: same(addr, me) };
  }));
  const now = Math.floor(Date.now() / 1000);
  return {
    id, g, status, round, members, pos, sym: tokenInfo(g.token).symbol,
    total: Number(g.maxMembers),
    late: status === "active" && now > Number(g.roundDeadline),
    secsLeft: Number(g.roundDeadline) - now,
    amMember: members.some((m) => m.isMe),
  };
}

function renderCircles() {
  const shown = cache.filter((c) =>
    filter === "mine" ? c.amMember :
    filter === "open" ? c.status === "open" :
    filter === "done" ? c.status === "done" : true
  );
  const box = $("groups");
  if (shown.length === 0) {
    const msg = cache.length === 0
      ? "No circles yet. Start the first one with the form."
      : filter === "mine" ? "You haven't joined a circle yet. Pick one with open seats, or start your own."
      : filter === "open" ? "No circles have open seats right now. Start one with the form."
      : "No circles have finished yet.";
    box.innerHTML = `<div class="empty">${msg}</div>`;
    return;
  }
  box.replaceChildren(...shown.map(circleCard));
}

function dotState(c, m) {
  if (c.status === "done") return m.missed ? "missed" : "done";
  if (c.status === "open") return "unpaid";
  if (m.i === c.round) return "now";
  if (m.missed) return "missed";
  if (m.paid) return "paid";
  if (m.i < c.round) return "received";
  return "unpaid";
}

function miniRing(c) {
  const N = c.total, C = 75, R = 56;
  const r = Math.max(6, Math.min(12, 130 / N));
  let dots = "";
  for (let i = 0; i < N; i++) {
    const a = (-90 + i * (360 / N)) * (Math.PI / 180);
    const x = C + R * Math.cos(a), y = C + R * Math.sin(a);
    const m = c.members[i];
    const cls = m ? dotState(c, m) : "empty-seat";
    dots += `<circle class="dot ${cls}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r}"><title>${m ? short(m.addr) : "Open seat"}</title></circle>`;
    if (m?.isMe) dots += `<circle class="dot-me" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r + 4}"></circle>`;
  }
  const pot = fmt(c.g.contribution * BigInt(N));
  return `<svg class="mini-ring" viewBox="0 0 150 150" aria-hidden="true">
    <circle class="track" cx="${C}" cy="${C}" r="${R}"></circle>${dots}
    <text class="center-amt" x="${C}" y="${C + 2}" text-anchor="middle">${pot}</text>
    <text class="center-lbl" x="${C}" y="${C + 16}" text-anchor="middle">${esc(c.sym)} pot</text>
  </svg>`;
}

function timeLeft(s) {
  if (s <= 0) return "deadline passed";
  if (s < 90) return `${s}s left`;
  if (s < 5400) return `${Math.ceil(s / 60)} min left`;
  return `${Math.round(s / 3600)} h left`;
}

function circleCard(c) {
  const { id, g, status, round, members, total, sym } = c;
  const contrib = fmt(g.contribution);
  const statusLabel = status === "open" ? `${total - members.length} seat${total - members.length === 1 ? "" : "s"} left`
    : status === "done" ? "Completed" : c.late ? "Round overdue" : `Round ${round + 1} of ${total}`;
  const statusCls = status === "open" ? "open" : status === "done" ? "done" : c.late ? "late" : "active";
  const me = members.find((m) => m.isMe);

  const rows = members.map((m) => {
    const tags = [];
    if (status === "active") {
      if (m.i === round) tags.push(`<span class="tag now">receives this round</span>`);
      else if (m.i < round) tags.push(`<span class="tag received">received</span>`);
      tags.push(m.paid ? `<span class="tag paid">paid</span>` : `<span class="tag unpaid">not paid yet</span>`);
    }
    if (m.missed) tags.push(`<span class="tag missed">missed a round</span>`);
    if (status === "done" && !m.missed) tags.push(`<span class="tag badge">earned badge</span>`);
    return `<li><span class="who ${m.isMe ? "me" : ""}">${m.i + 1}. ${m.isMe ? "You" : short(m.addr)}</span>${tags.join("")}</li>`;
  }).join("");

  const el = document.createElement("article");
  el.className = `circle${c.amMember ? " is-mine" : ""}`;
  el.innerHTML = `
    ${miniRing(c)}
    <div>
      <div class="circle-head">
        <h3>${esc(g.name)} <span class="circle-id">#${id}</span></h3>
        <span class="status ${statusCls}">${statusLabel}</span>
      </div>
      <div class="facts">
        <div><span>Each round </span><b>${contrib} ${esc(sym)}</b></div>
        <div><span>Members </span><b>${members.length}/${total}</b></div>
        <div><span>Round length </span><b>${Math.round(Number(g.roundDuration) / 60)} min</b></div>
        ${status === "active" ? `<div><span>Deadline </span><b>${timeLeft(c.secsLeft)}</b></div>` : ""}
      </div>
      ${yieldLine(c)}
      <ul class="members">${rows || `<li class="hint">No members yet. The first to join receives the first pot.</li>`}</ul>
      <div class="circle-actions"></div>
    </div>`;

  const actions = el.querySelector(".circle-actions");
  const add = (label, cls, fn) => {
    const b = document.createElement("button");
    b.className = `btn ${cls} btn-sm`;
    b.textContent = label;
    b.onclick = async () => { b.disabled = true; await fn(); b.disabled = false; };
    actions.appendChild(b);
  };
  const hint = (t) => actions.insertAdjacentHTML("beforeend", `<span class="hint">${t}</span>`);

  if (status === "open" && !me) add(`Join and lock ${contrib} ${sym}`, "btn-primary", () => onJoin(id, g));
  if (status === "open" && me) hint("You're in. The circle starts when every seat is filled.");
  if (status === "active" && me && !me.paid && !c.late) add(`Pay ${contrib} ${sym}`, "btn-primary", () => onPay(id, g));
  if (status === "active" && me?.paid) hint("You've paid this round.");
  const stuck = g.earnsYield && poolBlocked && (c.late || g.refundPending);
  if (stuck && canUnblock) add("Unblock pool", "btn-gold", onUnblock);
  if (c.late) add("Close round", "btn-warn", () => onClose(id, g));
  if (g.refundPending) add("Return collateral", "btn-warn", () => onFinalize(id, g));
  if (status === "done" && me && !me.missed && !g.refundPending) {
    hint(g.earnsYield ? "Collateral returned and BTC earnings credited. Your badge is in your wallet."
      : "Collateral returned. Your badge is in your wallet.");
  }
  return el;
}

function yieldLine(c) {
  const { g, status, pos } = c;
  if (!g.earnsYield) return "";
  if (poolBlocked && (c.late || g.refundPending)) {
    return `<p class="yield warn"><b>Mezo's Stability Pool is paused.</b> A Mezo loan fell below 110% collateral and hasn't been liquidated, so nobody can withdraw yet.${canUnblock ? " Press “Unblock pool” to liquidate it: you earn Mezo's liquidation reward and this circle earns BTC." : " Try again in a few minutes."}</p>`;
  }
  if (status === "open") {
    return `<p class="yield"><b>Earn while you save:</b> when the circle fills, everyone's collateral goes into Mezo's MUSD Stability Pool and earns BTC.</p>`;
  }
  if (g.refundPending) {
    return `<p class="yield warn"><b>Collateral is still in the Stability Pool.</b> Mezo paused withdrawals during a liquidation. Anyone can press “Return collateral” once it's open again.</p>`;
  }
  if (status === "done") return `<p class="yield"><b>Earned in the Stability Pool.</b> Members' BTC share is ready to claim at the top of the page.</p>`;
  const inPool = pos ? fmt(pos.musdInPool) : "-";
  const btc = pos ? fmt(pos.btcEarned, 8) : "-";
  return `<p class="yield"><b>Earning in Mezo's Stability Pool:</b> ${inPool} MUSD collateral deposited · <b>${btc} BTC</b> earned so far</p>`;
}

function updateFormSum() {
  const f = $("createForm");
  const amt = Number(f.amount.value) || 0;
  const n = Number(f.members.value) || 0;
  const mins = Number(f.minutes.value) || 0;
  const t = TOKENS.find((x) => x.address === f.token.value) || MAIN;
  const sym = t.symbol;
  f.earn.disabled = !t.yield;
  if (!t.yield) f.earn.checked = false;
  $("earnRow").classList.toggle("off", !t.yield);
  const earn = t.yield && f.earn.checked;
  $("formSum").innerHTML = amt && n
    ? `Each member pays <b>${amt.toLocaleString()} ${sym}</b> per round and locks the same as collateral. Each pot is <b>${(amt * n).toLocaleString()} ${sym}</b>. The full cycle takes <b>${n} rounds</b> (about ${Math.round((n * mins) / 6) / 10 || "<1"} h).${earn ? ` While it runs, the <b>${(amt * n).toLocaleString()} ${sym}</b> of collateral earns BTC in Mezo's Stability Pool.` : ""}`
    : "";
}

// ---------------------------------------------------------------------------
// Wire up
// ---------------------------------------------------------------------------
// Token picker, help links and labels depend on the network config.
$("tokenSelect").innerHTML = TOKENS.map((t) => `<option value="${t.address}">${esc(t.symbol)}</option>`).join("");
document.querySelectorAll("[data-sym]").forEach((el) => (el.textContent = MAIN.symbol));
document.querySelectorAll("[data-chain]").forEach((el) => (el.textContent = CONFIG.chainName));
if (!TOKENS.some((t) => t.yield)) $("earnRow").classList.add("hidden");
const faucetToken = TOKENS.find((t) => t.faucet);
if (faucetToken) {
  $("faucetBtn").textContent = `Get 1,000 ${faucetToken.symbol}`;
} else {
  $("faucetBtn").classList.add("hidden");
}
if (CONFIG.musdHelp) { $("getMusd").href = CONFIG.musdHelp; $("getMusd").classList.remove("hidden"); }
if (CONFIG.gasFaucet) { $("getGas").href = CONFIG.gasFaucet; $("getGas").classList.remove("hidden"); }

heroRing();
updateFormSum();

const contractList = Object.entries(CONFIG.contracts).filter(([, v]) => v && v !== ethers.ZeroAddress)
  .concat(TOKENS.map((t) => [t.symbol, t.address]))
  .map(([k, v]) => `<li><span>${k}</span><code>${v || "not deployed"}</code></li>`).join("");
$("contracts").innerHTML = contractList;

$("connectBtn").onclick = connect;
document.querySelectorAll("[data-connect]").forEach((b) => (b.onclick = connect));
$("acctBtn").onclick = async () => {
  try { await navigator.clipboard.writeText(me); toast("Address copied", "ok"); } catch { /* ignore */ }
};
$("createForm").onsubmit = onCreate;
$("createForm").oninput = updateFormSum;
$("refreshBtn").onclick = refresh;
$("claimBtn").onclick = async (ev) => { ev.target.disabled = true; await onClaim(); ev.target.disabled = false; };
$("faucetBtn").onclick = async (ev) => {
  ev.target.disabled = true;
  const c = tokenC[faucetToken.address.toLowerCase()];
  await send(`Claim ${faucetToken.symbol}`, `Claimed 1,000 ${faucetToken.symbol}`, () => c.faucet());
  ev.target.disabled = false;
};
document.querySelectorAll(".tab").forEach((t) => {
  t.onclick = () => {
    filter = t.dataset.filter;
    document.querySelectorAll(".tab").forEach((x) => {
      x.classList.toggle("is-on", x === t);
      x.setAttribute("aria-selected", x === t);
    });
    renderCircles();
  };
});

if (window.ethereum) {
  window.ethereum.on?.("accountsChanged", () => location.reload());
  window.ethereum.on?.("chainChanged", () => location.reload());
  // Reconnect silently if the site is already authorised.
  window.ethereum.request({ method: "eth_accounts" }).then((a) => a.length && connect()).catch(() => {});
}
