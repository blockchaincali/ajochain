import { ethers } from "https://cdn.jsdelivr.net/npm/ethers@6.13.4/dist/ethers.min.js";
import { CONFIG } from "./config.js";

// ---------------------------------------------------------------------------
// ABIs (human-readable). Custom errors are listed so reverts decode to names.
// ---------------------------------------------------------------------------
const MANAGER_ERRORS = [
  "error InvalidParams()", "error GroupNotFound()", "error NotOpen()", "error NotActive()",
  "error AlreadyMember()", "error NotMember()", "error AlreadyPaid()", "error RoundStillOpen()",
];
const MANAGER_ABI = [
  ...MANAGER_ERRORS,
  "function groupCount() view returns (uint256)",
  "function createGroup(string name, address token, uint256 contribution, uint8 maxMembers, uint64 roundDuration) returns (uint256)",
  "function join(uint256 groupId)",
  "function contribute(uint256 groupId)",
  "function closeRound(uint256 groupId)",
  "function getGroup(uint256 groupId) view returns (tuple(string name, address creator, address token, uint256 contribution, uint64 roundDuration, uint64 roundDeadline, uint8 maxMembers, uint8 currentRound, uint8 paidCount, uint8 status, uint256 pot))",
  "function getMembers(uint256 groupId) view returns (address[])",
  "function hasDefaulted(uint256, address) view returns (bool)",
  "function paidInRound(uint256, uint256, address) view returns (bool)",
];
const TOKEN_ABI = [
  "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
  "error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address, address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
  "function faucet()",
];
const BADGE_ABI = ["function balanceOf(address) view returns (uint256)"];

const FRIENDLY = {
  InvalidParams: "Check the form: 2–20 members, a contribution above 0, and rounds of at least 1 minute.",
  GroupNotFound: "That circle doesn't exist on this network.",
  NotOpen: "This circle is already full.",
  NotActive: "This circle isn't running right now.",
  AlreadyMember: "You're already in this circle.",
  NotMember: "Only members of this circle can pay into it.",
  AlreadyPaid: "You've already paid for this round.",
  RoundStillOpen: "The round can only be closed after its deadline.",
  ERC20InsufficientBalance: "Not enough aUSD. Use “Get 1,000 aUSD” first.",
  ERC20InsufficientAllowance: "aUSD spending wasn't approved. Try again and approve in your wallet.",
};

const isLocal = CONFIG.chainId === 31337;
const gasSymbol = CONFIG.nativeSymbol || "POT";

// ---------------------------------------------------------------------------
// State + helpers
// ---------------------------------------------------------------------------
let provider, signer, me, manager, token, badge;
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
    $("ringCaption").textContent = `Round ${i + 1} of ${names.length}: ${names[i]} receives 60 aUSD`;
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
        }],
      });
    } else throw e;
  }
}

async function connect() {
  if (!window.ethereum) return toast("No wallet found. Install MetaMask, then reload this page.", "error");
  const c = CONFIG.contracts;
  if (!c.AjoManager || !c.MockUSDT || !c.AjoBadge) {
    return toast("Contract addresses are missing. Run the deploy script first.", "error");
  }
  try {
    await window.ethereum.request({ method: "eth_requestAccounts" });
    await ensureChain();
    provider = new ethers.BrowserProvider(window.ethereum);
    signer = await provider.getSigner();
    me = await signer.getAddress();
    manager = new ethers.Contract(c.AjoManager, MANAGER_ABI, signer);
    token = new ethers.Contract(c.MockUSDT, TOKEN_ABI, signer);
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

async function ensureAllowance(amount) {
  const current = await token.allowance(me, CONFIG.contracts.AjoManager);
  if (current >= amount) return true;
  return send("Approve aUSD", "Approved aUSD for AjoChain", () =>
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
  const btn = form.querySelector("button");
  btn.disabled = true;
  const ok = await send(`Create “${name}”`, `Created circle “${name}”`, () =>
    manager.createGroup(name, CONFIG.contracts.MockUSDT, amount, members, seconds)
  );
  btn.disabled = false;
  if (ok) { form.reset(); updateFormSum(); }
}

const onJoin = async (id, amt) => (await ensureAllowance(amt)) && send(`Join circle #${id}`, `Joined circle #${id}`, () => manager.join(id));
const onPay = async (id, amt) => (await ensureAllowance(amt)) && send(`Pay circle #${id}`, `Paid this round in circle #${id}`, () => manager.contribute(id));
const onClose = (id) => send(`Close round in #${id}`, `Closed the round in circle #${id}`, () => manager.closeRound(id));

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
    : `<b>This wallet has no ${gasSymbol} for gas.</b><br>
       Request testnet ${gasSymbol} in the Portaldot Discord, then refresh this page.`;
  w.classList.remove("hidden");
}

async function refresh() {
  if (!manager) return;
  try {
    const [bal, gas, nBadges, count] = await Promise.all([
      token.balanceOf(me), provider.getBalance(me), badge.balanceOf(me), manager.groupCount(),
    ]);
    $("statBal").textContent = fmt(bal);
    $("statGasLabel").textContent = `${isLocal ? "ETH" : gasSymbol} for gas`;
    $("statGas").textContent = fmt(gas, 4);
    $("statBadges").textContent = nBadges.toString();
    showGasWarning(gas === 0n);

    const ids = [];
    for (let i = Number(count); i >= 1; i--) ids.push(i);
    cache = await Promise.all(ids.map(loadCircle));
    $("statJoined").textContent = cache.filter((c) => c.amMember).length;
    renderCircles();
  } catch (e) {
    console.error(e);
    toast(`Couldn't load circles: ${explain(e)}`, "error");
  }
}

async function loadCircle(id) {
  const [g, list] = await Promise.all([manager.getGroup(id), manager.getMembers(id)]);
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
    id, g, status, round, members,
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
    <text class="center-lbl" x="${C}" y="${C + 16}" text-anchor="middle">aUSD pot</text>
  </svg>`;
}

function timeLeft(s) {
  if (s <= 0) return "deadline passed";
  if (s < 90) return `${s}s left`;
  if (s < 5400) return `${Math.ceil(s / 60)} min left`;
  return `${Math.round(s / 3600)} h left`;
}

function circleCard(c) {
  const { id, g, status, round, members, total } = c;
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
        <div><span>Each round </span><b>${contrib} aUSD</b></div>
        <div><span>Members </span><b>${members.length}/${total}</b></div>
        <div><span>Round length </span><b>${Math.round(Number(g.roundDuration) / 60)} min</b></div>
        ${status === "active" ? `<div><span>Deadline </span><b>${timeLeft(c.secsLeft)}</b></div>` : ""}
      </div>
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

  if (status === "open" && !me) add(`Join and lock ${contrib} aUSD`, "btn-primary", () => onJoin(id, g.contribution));
  if (status === "open" && me) hint("You're in. The circle starts when every seat is filled.");
  if (status === "active" && me && !me.paid && !c.late) add(`Pay ${contrib} aUSD`, "btn-primary", () => onPay(id, g.contribution));
  if (status === "active" && me?.paid) hint("You've paid this round.");
  if (c.late) add("Close round", "btn-warn", () => onClose(id));
  if (status === "done" && me && !me.missed) hint("Collateral returned. Your badge is in your wallet.");
  return el;
}

function updateFormSum() {
  const f = $("createForm");
  const amt = Number(f.amount.value) || 0;
  const n = Number(f.members.value) || 0;
  const mins = Number(f.minutes.value) || 0;
  $("formSum").innerHTML = amt && n
    ? `Each member pays <b>${amt.toLocaleString()} aUSD</b> per round and locks the same as collateral. Each pot is <b>${(amt * n).toLocaleString()} aUSD</b>. The full cycle takes <b>${n} rounds</b> (about ${Math.round((n * mins) / 6) / 10 || "<1"} h).`
    : "";
}

// ---------------------------------------------------------------------------
// Wire up
// ---------------------------------------------------------------------------
heroRing();
updateFormSum();

const contractList = Object.entries(CONFIG.contracts)
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
$("faucetBtn").onclick = async (ev) => {
  ev.target.disabled = true;
  await send("Claim aUSD", "Claimed 1,000 aUSD", () => token.faucet());
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
