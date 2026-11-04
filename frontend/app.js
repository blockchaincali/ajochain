import { ethers } from "https://cdn.jsdelivr.net/npm/ethers@6.13.4/dist/ethers.min.js";
import { CONFIG } from "./config.js";

// ---------------------------------------------------------------------------
// ABIs (human-readable)
// ---------------------------------------------------------------------------
const MANAGER_ABI = [
  "function groupCount() view returns (uint256)",
  "function createGroup(string name, address token, uint256 contribution, uint8 maxMembers, uint64 roundDuration) returns (uint256)",
  "function join(uint256 groupId)",
  "function contribute(uint256 groupId)",
  "function closeRound(uint256 groupId)",
  "function getGroup(uint256 groupId) view returns (tuple(string name, address creator, address token, uint256 contribution, uint64 roundDuration, uint64 roundDeadline, uint8 maxMembers, uint8 currentRound, uint8 paidCount, uint8 status, uint256 pot))",
  "function getMembers(uint256 groupId) view returns (address[])",
  "function isMember(uint256, address) view returns (bool)",
  "function hasDefaulted(uint256, address) view returns (bool)",
  "function paidInRound(uint256, uint256, address) view returns (bool)",
  "function collateralOf(uint256, address) view returns (uint256)",
];
const TOKEN_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address, address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
  "function faucet()",
  "function symbol() view returns (string)",
];
const BADGE_ABI = ["function balanceOf(address) view returns (uint256)"];

const STATUS = ["Open", "Active", "Completed"];

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let provider, signer, me, manager, token, badge;
let refreshTimer;

const $ = (id) => document.getElementById(id);
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const fmt = (v) => Number(ethers.formatUnits(v, 18)).toLocaleString(undefined, { maximumFractionDigits: 2 });

function toast(msg, isError = false) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.toggle("error", isError);
  t.classList.remove("hidden");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add("hidden"), isError ? 7000 : 4000);
}

function log(msg, hash) {
  const li = document.createElement("li");
  const time = new Date().toLocaleTimeString();
  li.textContent = `${time}  ${msg}${hash ? `  tx ${hash}` : ""}`;
  $("log").prepend(li);
}

function errMsg(e) {
  return e?.shortMessage || e?.reason || e?.info?.error?.message || e?.message || String(e);
}

// ---------------------------------------------------------------------------
// Wallet
// ---------------------------------------------------------------------------
async function ensureChain() {
  const hexId = "0x" + CONFIG.chainId.toString(16);
  try {
    await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hexId }] });
  } catch (e) {
    if (e.code === 4902 || /Unrecognized chain/i.test(e.message || "")) {
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: hexId,
          chainName: CONFIG.chainName,
          rpcUrls: [CONFIG.rpcUrl],
          nativeCurrency: { name: CONFIG.nativeSymbol, symbol: CONFIG.nativeSymbol, decimals: 18 },
        }],
      });
    } else {
      throw e;
    }
  }
}

async function connect() {
  if (!window.ethereum) return toast("MetaMask not found. Install it to use AjoChain.", true);
  const c = CONFIG.contracts;
  if (!c.AjoManager || !c.MockUSDT || !c.AjoBadge) {
    return toast("Contract addresses missing in frontend/config.js. Deploy first.", true);
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

    $("connectBtn").classList.add("hidden");
    $("walletInfo").classList.remove("hidden");
    $("app").classList.remove("hidden");
    $("addr").textContent = short(me);
    $("netBadge").textContent = CONFIG.chainName;
    $("contracts").innerHTML = Object.entries(c).map(([k, v]) => `<li>${k}: ${v}</li>`).join("");

    await refresh();
    clearInterval(refreshTimer);
    refreshTimer = setInterval(refresh, 15000);
  } catch (e) {
    toast(errMsg(e), true);
  }
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------
async function send(label, fn) {
  try {
    toast(`${label}: confirm in your wallet…`);
    const tx = await fn();
    toast(`${label}: waiting for confirmation…`);
    await tx.wait();
    log(label, tx.hash);
    toast(`${label}: done ✓`);
    await refresh();
    return true;
  } catch (e) {
    toast(`${label} failed: ${errMsg(e)}`, true);
    return false;
  }
}

async function ensureAllowance(amount) {
  const current = await token.allowance(me, CONFIG.contracts.AjoManager);
  if (current >= amount) return true;
  return send("Approve aUSD", () => token.approve(CONFIG.contracts.AjoManager, ethers.MaxUint256));
}

async function onCreate(ev) {
  ev.preventDefault();
  const f = new FormData(ev.target);
  const name = f.get("name").trim();
  const amount = ethers.parseUnits(String(f.get("amount")), 18);
  const members = Number(f.get("members"));
  const seconds = Math.round(Number(f.get("minutes")) * 60);
  const ok = await send(`Create "${name}"`, () =>
    manager.createGroup(name, CONFIG.contracts.MockUSDT, amount, members, seconds)
  );
  if (ok) ev.target.reset();
}

async function onJoin(id, contribution) {
  if (!(await ensureAllowance(contribution))) return;
  await send(`Join group #${id}`, () => manager.join(id));
}

async function onContribute(id, contribution) {
  if (!(await ensureAllowance(contribution))) return;
  await send(`Contribute to group #${id}`, () => manager.contribute(id));
}

async function onClose(id) {
  await send(`Close round in group #${id}`, () => manager.closeRound(id));
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
async function refresh() {
  if (!manager) return;
  try {
    const [bal, nBadges, count] = await Promise.all([
      token.balanceOf(me),
      badge.balanceOf(me),
      manager.groupCount(),
    ]);
    $("bal").textContent = `${fmt(bal)} aUSD`;
    $("badges").textContent = `🏅 ${nBadges} badge${nBadges === 1n ? "" : "s"}`;

    const ids = [];
    for (let i = Number(count); i >= 1; i--) ids.push(i);
    if (ids.length === 0) {
      $("groups").innerHTML = `<p class="muted">No groups yet. Create the first one above.</p>`;
      return;
    }
    const cards = await Promise.all(ids.map(renderGroup));
    $("groups").replaceChildren(...cards);
  } catch (e) {
    toast(`Refresh failed: ${errMsg(e)}`, true);
  }
}

async function renderGroup(id) {
  const [g, memberList] = await Promise.all([manager.getGroup(id), manager.getMembers(id)]);
  const status = STATUS[Number(g.status)];
  const round = Number(g.currentRound);
  const total = Number(g.maxMembers);
  const isActive = status === "Active";
  const amMember = memberList.some((m) => m.toLowerCase() === me.toLowerCase());

  const memberInfo = await Promise.all(
    memberList.map(async (m, i) => {
      const [paid, defaulted] = await Promise.all([
        isActive ? manager.paidInRound(id, round, m) : Promise.resolve(false),
        manager.hasDefaulted(id, m),
      ]);
      return { addr: m, i, paid, defaulted };
    })
  );

  const now = Math.floor(Date.now() / 1000);
  const deadline = Number(g.roundDeadline);
  const overdue = isActive && now > deadline;
  const myInfo = memberInfo.find((x) => x.addr.toLowerCase() === me.toLowerCase());

  const el = document.createElement("div");
  el.className = "group";

  const statusPill =
    status === "Completed" ? "pill gold" : status === "Active" ? (overdue ? "pill red" : "pill") : "pill grey";

  const roundText = isActive ? `${round + 1} of ${total}` : status === "Completed" ? `${total} of ${total}` : "-";
  const deadlineText = isActive
    ? overdue
      ? "Overdue: round can be closed"
      : `${Math.max(0, Math.ceil((deadline - now) / 60))} min left`
    : "-";

  el.innerHTML = `
    <div class="group-head">
      <h4>#${id} · ${escapeHtml(g.name)}</h4>
      <span class="${statusPill}">${status}${overdue ? " · overdue" : ""}</span>
    </div>
    <div class="facts">
      <div><span>Contribution</span>${fmt(g.contribution)} aUSD</div>
      <div><span>Pot per round</span>${fmt(g.contribution * BigInt(total))} aUSD</div>
      <div><span>Members</span>${memberList.length} / ${total}</div>
      <div><span>Round</span>${roundText}</div>
      <div><span>Deadline</span>${deadlineText}</div>
    </div>
    <ul class="members">
      ${memberInfo
        .map((m) => {
          const isMe = m.addr.toLowerCase() === me.toLowerCase();
          const tags = [];
          if (isActive && m.i === round) tags.push(`<span class="pill gold">receives this round</span>`);
          if (isActive && m.i < round) tags.push(`<span class="pill soft">received</span>`);
          if (isActive) tags.push(m.paid ? `<span class="pill">paid ✓</span>` : `<span class="pill grey">not paid</span>`);
          if (m.defaulted) tags.push(`<span class="pill red">defaulted</span>`);
          if (status === "Completed" && !m.defaulted) tags.push(`<span class="pill gold">🏅 badge</span>`);
          return `<li class="${isMe ? "me" : ""}">${m.i + 1}. <span class="mono">${short(m.addr)}</span>${isMe ? " (you)" : ""} ${tags.join(" ")}</li>`;
        })
        .join("")}
      ${status === "Open" ? `<li class="muted">${total - memberList.length} seat(s) left</li>` : ""}
    </ul>
    <div class="actions"></div>
  `;

  const actions = el.querySelector(".actions");
  const addBtn = (label, cls, handler) => {
    const b = document.createElement("button");
    b.className = `btn ${cls}`;
    b.textContent = label;
    b.onclick = async () => {
      b.disabled = true;
      await handler();
      b.disabled = false;
    };
    actions.appendChild(b);
  };

  if (status === "Open" && !amMember) {
    addBtn(`Join (lock ${fmt(g.contribution)} aUSD collateral)`, "primary", () => onJoin(id, g.contribution));
  }
  if (isActive && amMember && myInfo && !myInfo.paid && !overdue) {
    addBtn(`Pay ${fmt(g.contribution)} aUSD`, "primary", () => onContribute(id, g.contribution));
  }
  if (overdue) {
    addBtn("Close round", "warn", () => onClose(id));
  }
  return el;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// ---------------------------------------------------------------------------
// Wire up
// ---------------------------------------------------------------------------
$("connectBtn").onclick = connect;
$("createForm").onsubmit = onCreate;
$("refreshBtn").onclick = refresh;
$("faucetBtn").onclick = () => send("Claim 1,000 aUSD", () => token.faucet());

if (window.ethereum) {
  window.ethereum.on?.("accountsChanged", () => location.reload());
  window.ethereum.on?.("chainChanged", () => location.reload());
}
