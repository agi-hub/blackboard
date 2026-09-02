// 「黑板」原型 — 粉笔画布引擎 + AI 交互（多页翻页版）
// 逻辑坐标空间固定 1600x1000，三层画布：背景纹理 / 用户手写 / AI板书
// 动画：逐字书写（每字 ~45ms，行间停顿），像老师一行一行写板书

"use strict";

// ---------- 常量与状态 ----------

const W = 1600; // 逻辑画布宽（LLM 坐标即此坐标系）
const H = 1000; // 逻辑画布高

const $ = (sel) => document.querySelector(sel);

const boardEl = $("#board");
const bgC = $("#bg-canvas");
const strokeC = $("#stroke-canvas");
const textC = $("#text-canvas");
const bgCtx = bgC.getContext("2d");
const strokeCtx = strokeC.getContext("2d");
const textCtx = textC.getContext("2d");
const eraserCursorEl = $("#eraser-cursor");

const THEMES = {
  black: { top: "#242927", bottom: "#151918", noiseAlpha: 0.5, frame: "linear-gradient(135deg,#6b4a2c,#4a3118 55%,#6b4a2c)" },
  green: { top: "#2d4f3f", bottom: "#1c352a", noiseAlpha: 0.45, frame: "linear-gradient(135deg,#7a5a35,#503619 55%,#7a5a35)" },
};

let theme = "black";
let tool = "chalk"; // chalk | eraser
let color = "#f2f0e6";
let brushSize = 5; // 逻辑像素

// 多页黑板：每页 = AI板书 blocks + 用户手写 strokes
let pages = [{ blocks: [], animated: false }];
let strokesByPage = [[]];
let curPage = 0;

const layouts = new Map(); // uid -> {lines:[], lineH}

let animState = null; // {order, schedule, total, written, acc, lastT}
let animRaf = 0;

const CHAR_MS_BASE = 45; // 每字书写耗时（ms）
const CHAR_MS_FAST = 26; // 长文本自动加速
const LINE_PAUSE = 150; // 换行停顿（ms）

let uidSeq = 0;
let seedSeq = (Date.now() & 0xffff) >>> 0;

// ---------- 工具：确定性随机（撤销重放与逐字动效不闪变） ----------

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function segRng(seed, i) {
  return mulberry32((seed ^ Math.imul(i + 1, 0x9e3779b9)) >>> 0);
}

// ---------- 画布尺寸与坐标 ----------

function fitCanvas(c) {
  const rect = boardEl.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  c.width = Math.max(1, Math.round(rect.width * dpr));
  c.height = Math.max(1, Math.round(rect.height * dpr));
}

function logicalTransform(ctx, c) {
  ctx.setTransform(c.width / W, 0, 0, c.height / H, 0, 0);
}

function toLogical(e) {
  const rect = boardEl.getBoundingClientRect();
  return {
    x: ((e.clientX - rect.left) / rect.width) * W,
    y: ((e.clientY - rect.top) / rect.height) * H,
    p: e.pointerType === "pen" && e.pressure > 0 ? e.pressure : 0.5,
  };
}

// ---------- 黑板底纹 ----------

let noiseTile = null;

function makeNoiseTile() {
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 128;
  const ctx = c.getContext("2d");
  const img = ctx.createImageData(128, 128);
  const rnd = mulberry32(20260902);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 120 + Math.floor(rnd() * 135);
    img.data[i] = v;
    img.data[i + 1] = v;
    img.data[i + 2] = v;
    img.data[i + 3] = Math.floor(rnd() * 26); // 低alpha噪点
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function paintBoard(ctx, pw, ph, themeKey) {
  const t = THEMES[themeKey];
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const g = ctx.createLinearGradient(0, 0, 0, ph);
  g.addColorStop(0, t.top);
  g.addColorStop(1, t.bottom);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, pw, ph);

  // 磨砂噪点
  if (!noiseTile) noiseTile = makeNoiseTile();
  ctx.globalAlpha = t.noiseAlpha;
  ctx.fillStyle = ctx.createPattern(noiseTile, "repeat");
  ctx.fillRect(0, 0, pw, ph);
  ctx.globalAlpha = 1;

  // 板擦留下的擦拭痕（确定性位置，切主题不跳动）
  const rnd = mulberry32(9527);
  for (let i = 0; i < 4; i++) {
    const cx = pw * (0.15 + rnd() * 0.7);
    const cy = ph * (0.15 + rnd() * 0.7);
    const rx = pw * (0.08 + rnd() * 0.12);
    const ry = ph * (0.03 + rnd() * 0.04);
    const rg = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(rx, ry));
    rg.addColorStop(0, "rgba(255,255,255,0.045)");
    rg.addColorStop(1, "rgba(255,255,255,0)");
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(rx / Math.max(rx, ry), ry / Math.max(rx, ry));
    ctx.translate(-cx, -cy);
    ctx.fillStyle = rg;
    ctx.fillRect(cx - Math.max(rx, ry), cy - Math.max(rx, ry), Math.max(rx, ry) * 2, Math.max(rx, ry) * 2);
    ctx.restore();
  }

  // 边缘暗角
  const vg = ctx.createRadialGradient(pw / 2, ph / 2, Math.min(pw, ph) * 0.35, pw / 2, ph / 2, Math.max(pw, ph) * 0.72);
  vg.addColorStop(0, "rgba(0,0,0,0)");
  vg.addColorStop(1, "rgba(0,0,0,0.4)");
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, pw, ph);
}

// ---------- 粉笔笔刷 ----------

function chalkSeg(ctx, x0, y0, x1, y1, chalkColor, size, rnd) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const dist = Math.hypot(dx, dy);
  if (dist < 0.01) dist = 0.01;
  const nx = -dy / dist;
  const ny = dx / dist;
  const steps = Math.max(1, Math.ceil(dist / 1.6));
  ctx.lineCap = "round";
  ctx.strokeStyle = chalkColor;
  ctx.fillStyle = chalkColor;
  for (let i = 0; i < steps; i++) {
    const t0 = i / steps;
    const t1 = (i + 1) / steps;
    // 两道平行细线，随机偏移 + 随机透明度 → 飞白
    for (let p = 0; p < 2; p++) {
      const off = (rnd() - 0.5) * size * 0.8;
      ctx.globalAlpha = 0.07 + rnd() * 0.15;
      ctx.lineWidth = Math.max(0.4, size * (0.28 + rnd() * 0.35));
      ctx.beginPath();
      ctx.moveTo(x0 + dx * t0 + nx * off + (rnd() - 0.5) * 0.7, y0 + dy * t0 + ny * off + (rnd() - 0.5) * 0.7);
      ctx.lineTo(x0 + dx * t1 + nx * off + (rnd() - 0.5) * 0.7, y0 + dy * t1 + ny * off + (rnd() - 0.5) * 0.7);
      ctx.stroke();
    }
    // 掉粉颗粒
    if (rnd() < 0.3) {
      ctx.globalAlpha = 0.1 + rnd() * 0.12;
      const d = Math.max(0.5, size * 0.14);
      ctx.fillRect(x0 + dx * t0 + (rnd() - 0.5) * size * 1.6, y0 + dy * t0 + (rnd() - 0.5) * size * 1.6, d, d);
    }
  }
  ctx.globalAlpha = 1;
}

function eraserSeg(ctx, x0, y0, x1, y1, size) {
  ctx.save();
  ctx.globalCompositeOperation = "destination-out";
  ctx.strokeStyle = "rgba(0,0,0,1)";
  ctx.globalAlpha = 0.96;
  ctx.lineWidth = size * 6;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
  ctx.restore();
}

function drawStrokeSegment(stroke, i) {
  // 画 pts[i-1] → pts[i] 段；随机源由 (seed, i-1) 决定，live 与重放完全一致
  const a = stroke.pts[i - 1];
  const b = stroke.pts[i];
  const p = b.p ?? 0.5;
  const eff = stroke.size * (0.7 + p * 0.6);
  logicalTransform(strokeCtx, strokeC);
  if (stroke.tool === "eraser") {
    eraserSeg(strokeCtx, a.x, a.y, b.x, b.y, stroke.size);
  } else {
    chalkSeg(strokeCtx, a.x, a.y, b.x, b.y, stroke.color, eff, segRng(stroke.seed, i - 1));
  }
}

function redrawStrokes() {
  strokeCtx.setTransform(1, 0, 0, 1, 0, 0);
  strokeCtx.clearRect(0, 0, strokeC.width, strokeC.height);
  for (const s of strokesByPage[curPage] ?? []) {
    for (let i = 1; i < s.pts.length; i++) drawStrokeSegment(s, i);
  }
}

// ---------- AI 板书渲染（逐字粉笔动效 + 重点标记） ----------

function fontString(b) {
  return `${b.fontSize}px "Xingkai SC","Kaiti SC","STKaiti","楷体","Chalkduster","Chalkboard SE",cursive`;
}

const CJK_RE = /[\u2e80-\u9fff\u3000-\u303f\uff00-\uffef]/;

function wrapText(ctx, text, maxWidth) {
  const lines = [];
  for (const raw of String(text).split("\n")) {
    if (!raw) {
      lines.push("");
      continue;
    }
    let line = "";
    let word = "";
    const flushWord = () => {
      if (!word) return;
      if (line && ctx.measureText(line + word).width <= maxWidth) line += word;
      else {
        if (line) lines.push(line);
        line = word;
      }
      word = "";
    };
    for (const ch of raw) {
      if (CJK_RE.test(ch)) {
        flushWord();
        if (line && ctx.measureText(line + ch).width > maxWidth) {
          lines.push(line);
          line = ch;
        } else line += ch;
      } else if (ch === " ") {
        flushWord();
        if (line && ctx.measureText(line + " ").width <= maxWidth) line += " ";
      } else {
        word += ch;
      }
    }
    flushWord();
    if (line || lines.length === 0) lines.push(line);
  }
  return lines;
}

function computeLayout(b) {
  textCtx.font = fontString(b);
  const lines = wrapText(textCtx, b.text, b.width);
  layouts.set(b.uid, { lines, lineH: b.fontSize * 1.7 });
  b._chars = lines.reduce((n, l) => n + l.length, 0);
}

function chalkChar(ctx, ch, x, y, b, rnd) {
  const jx = (rnd() - 0.5) * 1.6;
  const jy = (rnd() - 0.5) * 1.1; // 竖向抖动减半：避免"一高一低"
  ctx.save();
  ctx.translate(x + jx, y + jy);
  ctx.rotate((rnd() - 0.5) * 0.03);
  ctx.fillStyle = b.color;
  ctx.globalAlpha = 0.72 + rnd() * 0.28;
  ctx.fillText(ch, 0, 0);
  if (rnd() < 0.5) {
    // 复描一遍 → 粉笔颗粒感
    ctx.globalAlpha = 0.16 + rnd() * 0.15;
    ctx.fillText(ch, (rnd() - 0.5) * 1.2, (rnd() - 0.5) * 1.2);
  }
  ctx.restore();
  ctx.globalAlpha = 1;
}

// 粉笔下划线（标题/总结/重点词共用）
function drawChalkUnderline(ctx, x0, y, x1, chalkColor, rnd) {
  chalkSeg(ctx, x0, y, x1, y, chalkColor, 2.6, rnd);
}

// 手绘感圈选：两圈抖动椭圆，留缺口更像人画的
function drawChalkCircle(ctx, cx, cy, rx, ry, chalkColor, rnd) {
  ctx.strokeStyle = chalkColor;
  ctx.lineCap = "round";
  for (let pass = 0; pass < 2; pass++) {
    ctx.globalAlpha = 0.55 + rnd() * 0.3;
    ctx.lineWidth = 2 + rnd() * 1.6;
    const a0 = rnd() * Math.PI * 2;
    ctx.beginPath();
    ctx.ellipse(
      cx + (rnd() - 0.5) * 3,
      cy + (rnd() - 0.5) * 3,
      Math.max(10, rx + (rnd() - 0.5) * 7),
      Math.max(9, ry + (rnd() - 0.5) * 6),
      (rnd() - 0.5) * 0.15,
      a0,
      a0 + Math.PI * 1.92,
    );
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function drawBlock(ctx, b, allowed) {
  const lay = layouts.get(b.uid);
  if (!lay) return;
  ctx.font = fontString(b);
  let drawn = 0; // 块内已写字符数（跨行按顺序）
  for (let li = 0; li < lay.lines.length; li++) {
    const line = lay.lines[li];
    let x = b.x;
    const yBase = b.y + li * lay.lineH + b.fontSize * 0.9; // 基线
    for (const ch of line) {
      if (drawn >= allowed) return; // 本行未写完 → 本行重点标记也先不出
      chalkChar(ctx, ch, x, yBase, b, mulberry32(hashStr(b.uid) + drawn * 7919));
      x += ctx.measureText(ch).width;
      drawn++;
    }
    // 本行写完 → 画落在本行的重点标记（圈选/下划线），模拟老师写完即圈
    for (const em of b.emphasis ?? []) {
      const idx = line.indexOf(em.text);
      if (idx < 0) continue;
      const x0 = b.x + ctx.measureText(line.slice(0, idx)).width;
      const x1 = x0 + ctx.measureText(em.text).width;
      const rnd = mulberry32(hashStr(b.uid + "|" + em.text + "|" + li));
      if (em.style === "circle") {
        drawChalkCircle(ctx, (x0 + x1) / 2, yBase - b.fontSize * 0.3, (x1 - x0) / 2 + 7, b.fontSize * 0.55, em.color, rnd);
      } else {
        drawChalkUnderline(ctx, x0, yBase + b.fontSize * 0.12, x1, em.color, rnd);
      }
    }
  }
  // 标题 / 总结写完后补一条抖动粉笔下划线
  if (allowed >= b._chars && (b.kind === "title" || b.kind === "summary") && lay.lines.length > 0) {
    let wMax = 0;
    for (const l of lay.lines) wMax = Math.max(wMax, ctx.measureText(l).width);
    if (wMax > 30) {
      const uy = b.y + (lay.lines.length - 1) * lay.lineH + b.fontSize * 1.28;
      drawChalkUnderline(ctx, b.x, uy, b.x + wMax, b.color, mulberry32(hashStr(b.uid + "__u")));
    }
  }
}

// 书写中的粉笔头指示（动画期间显示在下一个字的位置）
function drawChalkCursor(ctx, x, y) {
  ctx.save();
  ctx.translate(x + 4, y - 4);
  ctx.rotate(-0.45);
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = "#f2f0e6";
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(0, -4, 30, 8, 3);
  else ctx.rect(0, -4, 30, 8);
  ctx.fill();
  // 笔尖
  ctx.fillStyle = "#d8d4c4";
  ctx.fillRect(-3, -4, 4, 8);
  ctx.restore();
  ctx.globalAlpha = 1;
}

function renderText(writtenBudget = Infinity) {
  textCtx.setTransform(1, 0, 0, 1, 0, 0);
  textCtx.clearRect(0, 0, textC.width, textC.height);
  logicalTransform(textCtx, textC);
  textCtx.textBaseline = "alphabetic";

  const curBlocks = pages[curPage]?.blocks ?? [];
  // 预计算动画中每个块的可写配额
  const quota = new Map();
  if (animState) {
    let budget = writtenBudget;
    for (const b of animState.order) {
      quota.set(b.uid, Math.max(0, Math.min(b._chars, budget)));
      budget -= b._chars;
    }
  }
  for (const b of curBlocks) {
    const allowed = quota.has(b.uid) ? quota.get(b.uid) : Infinity;
    if (allowed > 0) drawBlock(textCtx, b, allowed);
  }
  // 动画中 → 粉笔头停在下一个要写的字上
  if (animState && animState.written < animState.total) {
    const next = animState.schedule[animState.written];
    if (next) {
      const lay = layouts.get(next.b.uid);
      const line = lay.lines[next.li];
      textCtx.font = fontString(next.b);
      const x = next.b.x + textCtx.measureText(line.slice(0, next.ci)).width;
      const y = next.b.y + next.li * lay.lineH + next.b.fontSize * 0.9;
      drawChalkCursor(textCtx, x, y);
    }
  }
}

function stopAnim() {
  if (animRaf) cancelAnimationFrame(animRaf);
  animRaf = 0;
  animState = null;
}

// 逐行书写动画：schedule 决定每个字的时间片，行首额外停顿
function animateIn(newBlocks) {
  stopAnim();
  if (!newBlocks.length) {
    renderText();
    return;
  }
  const schedule = [];
  for (const b of newBlocks) {
    const lay = layouts.get(b.uid);
    if (!lay) continue;
    for (let li = 0; li < lay.lines.length; li++) {
      for (let ci = 0; ci < lay.lines[li].length; ci++) {
        schedule.push({ b, li, ci, lineStart: ci === 0 });
      }
    }
  }
  const total = schedule.length;
  const charMs = total > 220 ? CHAR_MS_FAST : CHAR_MS_BASE;
  animState = { order: newBlocks, schedule, total, written: 0, acc: 0, lastT: 0, charMs };

  const frame = (ts) => {
    if (!animState) return;
    if (!animState.lastT) animState.lastT = ts;
    const dt = ts - animState.lastT;
    animState.lastT = ts;
    animState.acc += dt;
    // 按时间预算推进字符（行首加停顿）
    while (animState.written < animState.total) {
      const next = animState.schedule[animState.written];
      const cost = animState.charMs + (next.lineStart && animState.written > 0 ? LINE_PAUSE : 0);
      if (animState.acc < cost) break;
      animState.acc -= cost;
      animState.written++;
    }
    renderText(animState.written);
    if (animState.written < animState.total) {
      animRaf = requestAnimationFrame(frame);
    } else {
      animRaf = 0;
      animState = null;
      renderText();
    }
  };
  animRaf = requestAnimationFrame(frame);
}

function normalizeIncoming(board, kindPrefix) {
  const out = [];
  const mk = (el, kind) => {
    if (!el || !el.text) return;
    const emphasis = Array.isArray(el.emphasis)
      ? el.emphasis
          .filter((e) => e && typeof e.text === "string" && e.text.trim())
          .slice(0, 8)
          .map((e) => ({
            text: e.text.trim().slice(0, 20),
            style: e.style === "circle" ? "circle" : "underline",
            color: /^#[0-9a-fA-F]{3,8}$/.test(e.color || "") ? e.color : "#ffe066",
          }))
      : [];
    const b = {
      uid: `u${++uidSeq}`,
      kind,
      id: el.id || kind,
      text: el.text,
      x: el.x,
      y: el.y,
      width: el.width || 560,
      fontSize: el.fontSize || 28,
      color: el.color || "#f0f0f0",
      emphasis,
    };
    computeLayout(b);
    out.push(b);
  };
  mk(board.title, "title");
  for (const blk of board.blocks || []) mk(blk, "block");
  mk(board.summary, "summary");
  return out.filter((b) => b._chars > 0);
}

// ---------- 翻页 ----------

function syncPageNav() {
  $("#page-indicator").textContent = `${curPage + 1} / ${pages.length}`;
  $("#btn-prev-page").disabled = curPage === 0;
  $("#btn-next-page").disabled = curPage >= pages.length - 1;
}

function goToPage(i) {
  if (i < 0 || i >= pages.length || i === curPage) return;
  stopAnim();
  renderText(); // 旧页定格
  curPage = i;
  syncPageNav();
  redrawStrokes();
  const p = pages[i];
  if (p.blocks.length && !p.animated) {
    p.animated = true; // 每页首次观看都有书写动效
    animateIn(p.blocks);
  } else {
    renderText();
  }
}

$("#btn-prev-page").addEventListener("click", () => goToPage(curPage - 1));
$("#btn-next-page").addEventListener("click", () => goToPage(curPage + 1));

// ---------- 指针输入 ----------

let current = null; // 书写中的笔画

boardEl.addEventListener("pointerdown", (e) => {
  if (e.pointerType === "mouse" && e.button !== 0) return;
  e.preventDefault();
  boardEl.setPointerCapture(e.pointerId);
  stopAnim(); // 用户落笔时结束动效，立即定格已写内容
  renderText();
  const pt = toLogical(e);
  current = {
    tool,
    color,
    size: brushSize,
    seed: (seedSeq = (seedSeq + 0x9e3779b9) >>> 0),
    pts: [pt, { ...pt, x: pt.x + 0.01, y: pt.y + 0.01 }], // 双点保证单点也能重放出"点"
  };
  strokesByPage[curPage].push(current);
  drawStrokeSegment(current, 1);
});

boardEl.addEventListener("pointermove", (e) => {
  if (tool === "eraser") moveEraserCursor(e);
  if (!current) return;
  const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
  for (const ev of events.length ? events : [e]) {
    const pt = toLogical(ev);
    const last = current.pts[current.pts.length - 1];
    if (Math.hypot(pt.x - last.x, pt.y - last.y) < 0.8) continue; // 过滤抖动
    current.pts.push(pt);
    drawStrokeSegment(current, current.pts.length - 1);
  }
});

function endStroke() {
  current = null;
}
boardEl.addEventListener("pointerup", endStroke);
boardEl.addEventListener("pointercancel", endStroke);

function moveEraserCursor(e) {
  const rect = boardEl.getBoundingClientRect();
  eraserCursorEl.hidden = false;
  eraserCursorEl.style.left = `${e.clientX - rect.left}px`;
  eraserCursorEl.style.top = `${e.clientY - rect.top}px`;
  const d = brushSize * 6 * (rect.width / W);
  eraserCursorEl.style.width = `${d}px`;
  eraserCursorEl.style.height = `${d}px`;
}

// ---------- 工具栏 ----------

for (const dot of document.querySelectorAll(".chalk-dot")) {
  dot.addEventListener("click", () => {
    color = dot.dataset.color;
    tool = "chalk";
    syncToolbar();
  });
}
for (const btn of document.querySelectorAll(".size-btn")) {
  btn.addEventListener("click", () => {
    brushSize = Number(btn.dataset.size);
    syncToolbar();
  });
}

$("#btn-eraser").addEventListener("click", () => {
  tool = tool === "eraser" ? "chalk" : "eraser";
  syncToolbar();
});

$("#btn-undo").addEventListener("click", undo);
$("#btn-clear").addEventListener("click", clearAll);

function undo() {
  const s = strokesByPage[curPage];
  if (!s.length) return toast("没有可撤销的笔画", "");
  s.pop();
  redrawStrokes();
}

function clearAll() {
  const p = pages[curPage];
  const s = strokesByPage[curPage];
  if (!s.length && !p.blocks.length) return;
  if (!confirm(`清空第 ${curPage + 1} 页黑板（手写 + AI板书）？`)) return;
  stopAnim();
  p.blocks = [];
  p.animated = true;
  strokesByPage[curPage] = [];
  redrawStrokes();
  renderText();
}

function syncToolbar() {
  for (const d of document.querySelectorAll(".chalk-dot")) d.classList.toggle("active", tool === "chalk" && d.dataset.color === color);
  for (const b of document.querySelectorAll(".size-btn")) b.classList.toggle("active", Number(b.dataset.size) === brushSize);
  $("#btn-eraser").classList.toggle("active", tool === "eraser");
  boardEl.classList.toggle("eraser-mode", tool === "eraser");
  if (tool !== "eraser") eraserCursorEl.hidden = true;
}

$("#btn-theme").addEventListener("click", () => {
  theme = theme === "black" ? "green" : "black";
  $("#board-frame").style.background = THEMES[theme].frame;
  paintBoard(bgCtx, bgC.width, bgC.height, theme);
  toast(theme === "black" ? "经典黑板" : "护眼绿板", "");
});

$("#btn-export").addEventListener("click", exportPNG);

function exportPNG() {
  const scale = 2; // 高清导出
  const out = document.createElement("canvas");
  out.width = W * scale;
  out.height = H * scale;
  const ctx = out.getContext("2d");
  paintBoard(ctx, out.width, out.height, theme);
  ctx.drawImage(strokeC, 0, 0, out.width, out.height);
  ctx.drawImage(textC, 0, 0, out.width, out.height);
  const a = document.createElement("a");
  const ts = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
  a.download = `黑板-第${curPage + 1}页-${ts}.png`;
  a.href = out.toDataURL("image/png");
  a.click();
  toast("已导出高清 PNG", "ok");
}

window.addEventListener("keydown", (e) => {
  const tag = (e.target && e.target.tagName) || "";
  if (tag === "INPUT" || tag === "TEXTAREA") return;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
    e.preventDefault();
    undo();
  } else if (e.key === "ArrowLeft") {
    goToPage(curPage - 1);
  } else if (e.key === "ArrowRight") {
    goToPage(curPage + 1);
  }
});

// ---------- AI 交互 ----------

function thinking(on, text) {
  const el = $("#thinking");
  el.classList.toggle("hidden", !on);
  if (on) $("#thinking-text").textContent = text || "AI 正在思考…";
  for (const id of ["btn-answer", "btn-generate"]) {
    const b = document.getElementById(id);
    if (b) b.disabled = !!on;
  }
}

function toast(msg, type = "") {
  const el = $("#toast");
  el.textContent = msg;
  el.className = type;
  el.classList.remove("hidden");
  requestAnimationFrame(() => el.classList.add("show"));
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.classList.add("hidden"), 300);
  }, 2600);
}

// 文本转板书（多页替换式）
async function generateBoard() {
  const text = $("#text-input").value.trim();
  if (!text) return toast("先粘贴一些文本", "err");
  thinking(true, "AI 正在精炼排版…");
  try {
    const res = await fetch("/api/text2board", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, canvasW: W, canvasH: H }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || `HTTP ${res.status}`);
    const newPages = (data.pages || [])
      .map((p) => ({ blocks: normalizeIncoming(p, "b"), animated: false }))
      .filter((p) => p.blocks.length > 0);
    if (!newPages.length) throw new Error("模型没有生成有效板书，请重试");
    stopAnim();
    pages = newPages;
    strokesByPage = pages.map(() => []); // 新板书 = 换新黑板，手写清空
    curPage = 0;
    syncPageNav();
    redrawStrokes();
    pages[0].animated = true;
    animateIn(pages[0].blocks);
    $("#drawer").classList.add("hidden");
    toast(pages.length > 1 ? `板书已生成，共 ${pages.length} 页（←/→ 翻页）` : "板书已生成", "ok");
  } catch (err) {
    toast(err.message.includes("Failed to fetch") ? "无法连接本地服务" : err.message, "err");
  } finally {
    thinking(false);
  }
}

// AI 解答（追加到当前页，整屏截图 → 多模态）
async function answerBoard() {
  const p = pages[curPage];
  if (!strokesByPage[curPage].length && !p.blocks.length) {
    return toast("黑板是空的，先写点什么或先生成板书", "err");
  }
  thinking(true, "AI 正在识别黑板并思考…");
  try {
    const snap = document.createElement("canvas");
    snap.width = W;
    snap.height = H;
    const sctx = snap.getContext("2d");
    paintBoard(sctx, W, H, theme);
    sctx.drawImage(strokeC, 0, 0, W, H);
    sctx.drawImage(textC, 0, 0, W, H);

    const res = await fetch("/api/answer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: snap.toDataURL("image/jpeg", 0.85), canvasW: W, canvasH: H }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || `HTTP ${res.status}`);
    const board = data.board || data.pages?.[0];
    const blocks = normalizeIncoming(board ?? {}, "a");
    if (!blocks.length) throw new Error("模型没有返回作答内容，请重试");
    p.blocks = p.blocks.concat(blocks);
    animateIn(blocks);
    toast("AI 已作答", "ok");
  } catch (err) {
    toast(err.message.includes("Failed to fetch") ? "无法连接本地服务" : err.message, "err");
  } finally {
    thinking(false);
  }
}

$("#btn-generate").addEventListener("click", generateBoard);
$("#btn-answer").addEventListener("click", answerBoard);

// 抽屉
$("#btn-layout").addEventListener("click", () => $("#drawer").classList.toggle("hidden"));
$("#btn-drawer-close").addEventListener("click", () => $("#drawer").classList.add("hidden"));
$("#btn-sample").addEventListener("click", () => {
  $("#text-input").value = [
    "# 会议纪要：大模型 Agent 产品评审会",
    "",
    "大家好！感谢各位百忙之中参加今天的会议，今天我们主要讨论一下下一季度大模型 Agent 产品的规划方向，",
    "我先把背景简单介绍一下，然后大家畅所欲言，最后我们汇总一下结论和待办事项。",
    "",
    "首先说一下背景。过去一个季度我们的 Agent 产品 DAU 稳定在 5 万左右，但留存率只有 23%，",
    "用户反馈主要集中在三点：第一，任务执行链路太长，用户看不懂 Agent 在干什么；",
    "第二，失败之后的重试成本很高，用户宁可自己动手；第三，多轮对话的上下文经常丢失。",
    "",
    "产品侧提出的方案是把“自动执行”改成“规划-确认-执行”三段式，先给用户看计划，确认后再跑。",
    "同时增加每一步的实时日志面板。技术上需要评估流式 DAG 编排的改造工作量，",
    "预估是 3 个人 6 周。测试同学提醒灰度要先开 5%，观察一周的核心漏斗。",
    "",
    "总之今天的结论就是：方向认可，先做 MVP 验证规划确认这一步对留存的提升，",
    "下周五之前出详细排期。散会！",
  ].join("\n");
});

// ---------- 设置 ----------

$("#btn-settings").addEventListener("click", openSettings);
$("#btn-settings-close").addEventListener("click", () => $("#settings-modal").classList.add("hidden"));
$("#settings-modal").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) $("#settings-modal").classList.add("hidden");
});

async function openSettings() {
  try {
    const res = await fetch("/api/config");
    const cfg = await res.json();
    $("#cfg-baseUrl").value = cfg.baseUrl || "";
    $("#cfg-apiKey").value = cfg.apiKeyMasked || "";
    $("#cfg-textModel").value = cfg.textModel || "";
    $("#cfg-visionModel").value = cfg.visionModel || "";
    $("#cfg-maxRPM").value = cfg.maxRPM || 10;
    $("#cfg-disableThinking").checked = cfg.disableThinking !== false;
    $("#cfg-status").textContent = cfg.hasKey ? "已配置密钥" : "未配置密钥，AI 功能不可用";
  } catch {
    $("#cfg-status").textContent = "读取配置失败";
  }
  $("#settings-modal").classList.remove("hidden");
}

$("#btn-cfg-save").addEventListener("click", async () => {
  const body = {
    baseUrl: $("#cfg-baseUrl").value.trim(),
    apiKey: $("#cfg-apiKey").value.trim(),
    textModel: $("#cfg-textModel").value.trim(),
    visionModel: $("#cfg-visionModel").value.trim(),
    maxRPM: Number($("#cfg-maxRPM").value) || 10,
    disableThinking: $("#cfg-disableThinking").checked,
  };
  try {
    const res = await fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || `HTTP ${res.status}`);
    $("#cfg-status").textContent = "已保存 ✓";
    toast("设置已保存", "ok");
    setTimeout(() => $("#settings-modal").classList.add("hidden"), 600);
  } catch (err) {
    $("#cfg-status").textContent = `保存失败: ${err.message}`;
  }
});

// ---------- 尺寸自适应（等比 letterbox） ----------

function relayout() {
  // 等比适配：画布严格保持 1600:1000，xy 缩放一致，字形/笔画不变形
  const fr = $("#board-frame").getBoundingClientRect();
  const availW = Math.max(100, fr.width - 32); // 减去木框 padding 16*2
  const availH = Math.max(100, fr.height - 32);
  const s = Math.min(availW / W, availH / H);
  boardEl.style.width = `${Math.floor(W * s)}px`;
  boardEl.style.height = `${Math.floor(H * s)}px`;
  for (const c of [bgC, strokeC, textC]) fitCanvas(c);
  paintBoard(bgCtx, bgC.width, bgC.height, theme);
  redrawStrokes();
  renderText(animState ? animState.written : Infinity);
}

new ResizeObserver(relayout).observe($("#board-frame"));

// ---------- 启动 ----------

relayout();
syncToolbar();
syncPageNav();
fetch("/api/config")
  .then((r) => r.json())
  .then((cfg) => {
    if (!cfg.hasKey) {
      toast("尚未配置 API Key，点「⚙ 设置」填写后即可使用 AI", "err");
    }
  })
  .catch(() => {});
