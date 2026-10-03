/**
 * 量出当前后端所指向的那个 Azure 资源上，数字人的两个限制。
 *
 * 为什么需要这个脚本：这两个限制在 Azure 侧**完全不可见**——资源的 usage API 没有条目、Monitor 的
 * ClientErrors 为 0、Microsoft.Quota 对 CognitiveServices 作用域直接 BadRequest、区域 usages API 的
 * 287 项里没有任何 avatar/speech 项（详见 docs/avatar-rate-limit.md）。拒绝是从 Voice Live 的 WebSocket
 * 里以 in-band error 事件回来的，从不变成资源上的 HTTP 4xx，所以**唯一的观测手段就是实测**。
 *
 * 量什么：
 *   A) 并发上限  —— 每 38 秒只开 1 个（约 2.4 次/分钟，避开速率限制），直到拿到
 *                   avatar_service_resource_exhausted。
 *   B) 速率额度  —— 快速连开，直到拿到 rate_limit_exceeded；并用 "Retry after" 反推窗口长度。
 *
 * 前提：后端在 :8000（真实 Azure 凭据）、前端 vite 在 :5173、**persona 必须带数字人形象**
 *      （character 非空；纯语音不建 avatar 连接，这个脚本就什么也量不到）。
 *
 * 用法：
 *   cd frontend
 *   AU=<admin 用户名> AP=<admin 密码> node e2e/scripts/avatar-limits.mjs            # 两项都量
 *   AU=.. AP=.. MODE=concurrency node e2e/scripts/avatar-limits.mjs                 # 只量并发
 *   AU=.. AP=.. MODE=rate node e2e/scripts/avatar-limits.mjs                        # 只量速率
 *   AU=.. AP=.. BASE=http://localhost:5174 API=http://127.0.0.1:8001 node ...       # 指向第二套环境
 *
 * 换资源怎么量：改 service_configs.endpoint 后重启后端，再跑一次。两个资源各跑一次即可验证
 * 「限制是否按资源计」。
 *
 * 注意：每次成功建连都会真实消耗配额，并产生 Azure 费用。量完会把会话全部关闭。
 */
import { chromium } from "@playwright/test";

const API = process.env.API || "http://127.0.0.1:8000";
const BASE = process.env.BASE || "http://localhost:5173";
const MODE = process.env.MODE || "both";
/** 并发爬坡的间隔。38 秒 ≈ 2.4 次/分钟，低于已实测的 3 次/60 秒，所以不会被速率限制干扰。 */
const RAMP_GAP_MS = Number(process.env.RAMP_GAP_MS || 38000);
/** 爬坡的硬上限，防止在配额很高的资源上无限开下去。 */
const MAX_SESSIONS = Number(process.env.MAX_SESSIONS || 12);
/** 每次尝试等多久判定成败。建连通常 2–4 秒，12 秒留足余量。 */
const SETTLE_MS = Number(process.env.SETTLE_MS || 12000);

if (!process.env.AU || !process.env.AP) {
  console.error("需要 AU / AP（后端 .env 里的 SEED_ADMIN_USERNAME / SEED_ADMIN_PASSWORD）");
  process.exit(2);
}

const browser = await chromium.launch({
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
  ],
});

/** 走 admin 拿到候选人 token（密码由后端 SECRET_KEY 派生，不硬编码）。 */
async function candidateToken() {
  const ctx = await browser.newContext();
  const j = async (r) => r.json();
  const at = (
    await j(
      await ctx.request.post(`${API}/auth/login`, {
        headers: { "Content-Type": "application/json" },
        data: { username: process.env.AU, password: process.env.AP },
      }),
    )
  ).access_token;
  const users = await j(await ctx.request.get(`${API}/admin/users`, { headers: { Authorization: `Bearer ${at}` } }));
  const pw = users.find((u) => u.username === "user1")?.generated_password;
  const ct = (
    await j(
      await ctx.request.post(`${API}/auth/login`, {
        headers: { "Content-Type": "application/json" },
        data: { username: "user1", password: pw },
      }),
    )
  ).access_token;
  await ctx.close();
  return ct;
}

const token = await candidateToken();
const t0 = Date.now();
const secs = () => ((Date.now() - t0) / 1000).toFixed(0).padStart(4);
const open_ = [];

/** 开一个会话并返回结果。成功的会话保持打开（并发测量需要它们占着容量）。 */
async function attempt(tag) {
  const ctx = await browser.newContext({ viewport: { width: 480, height: 360 }, permissions: ["microphone"] });
  await ctx.addInitScript(([k, v]) => sessionStorage.setItem(k, v), ["candidate_access_token", token]);
  const page = await ctx.newPage();
  const rec = { tag, ctx, ok: false, err: null, avatarEnabled: null, offeredAt: null, errAt: null };
  page.on("websocket", (ws) => {
    if (!/voice-live\/ws/.test(ws.url())) return;
    ws.on("framesent", (f) => {
      if (typeof f.payload !== "string") return;
      try {
        if (JSON.parse(f.payload).type === "session.avatar.connect") rec.offeredAt = Date.now();
      } catch {}
    });
    ws.on("framereceived", (f) => {
      if (typeof f.payload !== "string") return;
      try {
        const m = JSON.parse(f.payload);
        if (m.type === "proxy.connected") rec.avatarEnabled = Boolean(m.avatar_enabled);
        if (m.type === "session.avatar.switch_to_speaking") rec.ok = true;
        if (m.type === "error" && !rec.err) {
          rec.err = { code: m.error?.code, msg: m.error?.message || "" };
          // 记录错误【到达】的时刻，而不是等待结束的时刻。用后者反推窗口会把 SETTLE_MS
          // （最多 12 秒）算进窗口长度里 —— 第一版就是这样把 60 秒报成了 69 秒。
          rec.errAt = Date.now();
        }
      } catch {}
    });
  });
  await page.goto(`${BASE}/interview`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: /开始面试|start interview/i }).click().catch(() => {});
  await page.getByRole("button", { name: /我准备好了|i'm ready/i }).click().catch(() => {});
  const vb = page.getByRole("button", { name: /answer by voice|语音作答/i });
  if (await vb.count()) await vb.click().catch(() => {});
  await new Promise((r) => setTimeout(r, SETTLE_MS));
  if (rec.ok) open_.push(rec);
  else await ctx.close();
  return rec;
}

/** Azure 的 "Retry after 40.0s." → 40。用来反推窗口长度。 */
const retryAfter = (msg) => {
  const m = /Retry after ([\d.]+)s/.exec(msg || "");
  return m ? Number(m[1]) : null;
};

const report = [];

if (MODE === "both" || MODE === "concurrency") {
  console.log(`\n── A) 并发上限（每 ${RAMP_GAP_MS / 1000}s 开 1 个，避开速率限制）──`);
  let hit = null;
  for (let i = 1; i <= MAX_SESSIONS; i++) {
    const r = await attempt(`#${i}`);
    if (i === 1 && r.avatarEnabled === false) {
      console.log("  ⚠️ persona 没有数字人形象（avatar_enabled=false），这个脚本量不到 avatar 限制。");
      console.log("     请把 persona 的 character 设为某个形象后重跑。");
      await browser.close();
      process.exit(3);
    }
    console.log(`${secs()}s  ${r.tag} ${r.ok ? `✅ 建连    当前并发 ${open_.length}` : `❌ [${r.err?.code ?? "无 error 帧"}] ${(r.err?.msg || "").slice(0, 80)}`}`);
    if (r.err?.code === "avatar_service_resource_exhausted") { hit = open_.length; break; }
    if (r.err?.code === "rate_limit_exceeded") {
      const ra = retryAfter(r.err.msg);
      console.log(`      （撞到速率限制而非并发上限，等 ${ra ?? 62} 秒后重试同一序号）`);
      await new Promise((res) => setTimeout(res, ((ra ?? 62) + 2) * 1000));
      i--; continue;
    }
    if (i === MAX_SESSIONS) break;
    await new Promise((res) => setTimeout(res, RAMP_GAP_MS));
  }
  report.push(hit !== null
    ? `并发上限 = ${hit}（第 ${hit + 1} 个被 avatar_service_resource_exhausted 拒绝）`
    : `并发开到 ${open_.length} 仍未触顶（MAX_SESSIONS=${MAX_SESSIONS}，可调大再测）`);
  // 释放，避免干扰速率测量，也避免白烧 Azure 容量
  for (const r of open_.splice(0)) await r.ctx.close();
  console.log(`${secs()}s  已关闭全部会话（释放会立刻归还并发容量，但【不】归还速率额度）`);
}

if (MODE === "both" || MODE === "rate") {
  if (MODE === "both") {
    console.log(`\n  等 65 秒让速率窗口清空，再量速率额度…`);
    await new Promise((r) => setTimeout(r, 65000));
  }
  console.log(`\n── B) 速率额度（快速连开，直到被 rate_limit_exceeded 拒绝）──`);
  let firstOfferAt = null, allowed = 0, windowS = null;
  for (let i = 1; i <= MAX_SESSIONS; i++) {
    const r = await attempt(`#${i}`);
    if (r.offeredAt && !firstOfferAt) firstOfferAt = r.offeredAt;
    if (r.ok) { allowed++; console.log(`${secs()}s  ${r.tag} ✅ 建连`); continue; }
    console.log(`${secs()}s  ${r.tag} ❌ [${r.err?.code ?? "无 error 帧"}] ${(r.err?.msg || "").slice(0, 80)}`);
    if (r.err?.code === "rate_limit_exceeded") {
      const ra = retryAfter(r.err.msg);
      if (ra !== null && firstOfferAt && r.errAt) {
        // Retry after 是「窗口里最老那次创建还有多久滚出窗口」，所以
        //   窗口长度 = (错误到达时刻 + Retry after) − 第一次创建的时刻
        // 必须用错误【到达】的时刻 r.errAt，不能用现在 —— 见上面注释。
        windowS = Math.round((r.errAt + ra * 1000 - firstOfferAt) / 1000);
      }
      break;
    }
    if (r.err?.code === "avatar_service_resource_exhausted") {
      console.log("      （先撞到并发上限：说明此资源的并发余量比速率额度更紧）");
      break;
    }
  }
  report.push(`速率额度 = ${allowed} 次${windowS ? ` / 约 ${windowS} 秒窗口（由 Retry after 反推）` : ""}`);
  for (const r of open_.splice(0)) await r.ctx.close();
}

console.log(`\n===== 结果 =====`);
for (const line of report) console.log(`  ${line}`);
console.log(`  说明：这两个数字只对后端当前指向的那个资源有效。换资源重跑即可比较。`);
console.log(`  背景与全部实测记录：docs/avatar-rate-limit.md`);
await browser.close();
