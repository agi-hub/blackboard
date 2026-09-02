// 「黑板」原型 — 粉笔画布引擎 + AI 交互（分区排版版）
// 架构：LLM 只输出分区语义（regions + 归属块），前端做确定性排版 → 根治坐标乱
// 动画：时间线调度，分隔线先画 → 逐字渐现（每字透明度爬升）→ 重点圈/划

"use strict";

// ---------- 常量与状态 ----------

const W = 1600;
const H = 1000;

const $ = (sel) => document.querySelector(sel);

const boardEl = $("#board");
const bgC = $("#bg-canvas");
const strokeC = $("#stroke-canvas");
const textC = $("#text-canvas");
const bgCtx = bgC.getContext("2d");
const strokeCtx = strokeC.getContext("2d");
const textCtx = textC.getContext("2d");
const eraserCursorEl = $("#eraser-cursor");

const FONT_STACK = `"Kaiti SC","STKaiti","楷体","Xingkai SC",serif`;

const THEMES = {
  black: { base: "#20241f", frame: "linear-gradient(135deg,#6b4a2c,#4a3118 55%,#6b4a2c)" },
  green: { base: "#2b4a3a", frame: "linear-gradient(135deg,#7a5a35,#503619 55%,#7a5a35)" },
};

let theme = "green"; // 默认护眼绿板
let tool = "chalk";
let color = "#f2f0e6";
let brushSize = 5;

// 多页黑板：每页 = 区域 + 板书 + 用户手写
let pages = [newPage()];
let strokesByPage = [[]];
let curPage = 0;

const layouts = new Map(); // uid -> {lines, lineH}

let animState = null; // {entries[], dur, startTs, tNow, done}
let animRaf = 0;

const CHAR_MS = 100; // 每字约 10 字/秒 ≈ 人手写速度（约5字/秒）的两倍
const CHAR_MS_FAST = 70; // 长页自动加速（约14字/秒）
const LINE_PAUSE = 300;
const DIVIDER_MS = 350;

let uidSeq = 0;
let seedSeq = (Date.now() & 0xffff) >>> 0;

// ---------- 工具：确定性随机 ----------

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

function clampNum(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
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
    img.data[i + 3] = Math.floor(rnd() * 26);
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function paintBoard(ctx, pw, ph, themeKey) {
  const t = THEMES[themeKey];
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  // 纯色板面（无渐变 / 无反光高光 / 无暗角）
  ctx.fillStyle = t.base;
  ctx.fillRect(0, 0, pw, ph);
  // 极淡的磨砂颗粒（哑光质感，非反光）
  if (!noiseTile) noiseTile = makeNoiseTile();
  ctx.globalAlpha = 0.18;
  ctx.fillStyle = ctx.createPattern(noiseTile, "repeat");
  ctx.fillRect(0, 0, pw, ph);
  ctx.globalAlpha = 1;
}

// ---------- 粉笔笔刷（手写层） ----------

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
    for (let p = 0; p < 2; p++) {
      const off = (rnd() - 0.5) * size * 0.8;
      ctx.globalAlpha = 0.07 + rnd() * 0.15;
      ctx.lineWidth = Math.max(0.4, size * (0.28 + rnd() * 0.35));
      ctx.beginPath();
      ctx.moveTo(x0 + dx * t0 + nx * off + (rnd() - 0.5) * 0.7, y0 + dy * t0 + ny * off + (rnd() - 0.5) * 0.7);
      ctx.lineTo(x0 + dx * t1 + nx * off + (rnd() - 0.5) * 0.7, y0 + dy * t1 + ny * off + (rnd() - 0.5) * 0.7);
      ctx.stroke();
    }
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

// ---------- 石膏磨砂字粒（sprite 缓存 + 颗粒孔洞） ----------

const spriteCache = new Map();

function chalkSprite(ch, fontSize, chalkColor) {
  const key = `${ch}|${fontSize}|${chalkColor}`;
  const hit = spriteCache.get(key);
  if (hit) return hit;
  const scale = 2; // 2x 内部分辨率，缩放后仍锐利
  const pad = Math.ceil(fontSize * 0.3);
  const cw = Math.ceil(fontSize * 1.7) + pad * 2;
  const chh = Math.ceil(fontSize * 1.9) + pad * 2;
  const c = document.createElement("canvas");
  c.width = Math.ceil(cw * scale);
  c.height = Math.ceil(chh * scale);
  const g = c.getContext("2d");
  g.scale(scale, scale);
  g.font = `${fontSize}px ${FONT_STACK}`;
  g.textBaseline = "alphabetic";
  g.fillStyle = chalkColor;
  g.fillText(ch, pad, pad + fontSize);
  // 石膏磨砂：destination-out 打颗粒孔洞（确定性，动画不闪变）
  g.globalCompositeOperation = "destination-out";
  const rnd = mulberry32(hashStr(key));
  const n = Math.round(fontSize * 1.15);
  for (let i = 0; i < n; i++) {
    g.globalAlpha = 0.22 + rnd() * 0.5;
    const s = 0.5 + rnd() * 1.2;
    g.fillRect(rnd() * cw, rnd() * chh, s, s);
  }
  g.globalCompositeOperation = "source-over";
  g.globalAlpha = 1;
  if (spriteCache.size > 3000) spriteCache.clear();
  spriteCache.set(key, c);
  return c;
}

function chalkChar(ctx, ch, x, y, b, rnd, alphaScale = 1, colorOverride) {
  const chalkColor = colorOverride || b.color;
  const spr = chalkSprite(ch, b.fontSize, chalkColor);
  const jx = (rnd() - 0.5) * 1.6;
  const jy = (rnd() - 0.5) * 1.1;
  const pad = Math.ceil(b.fontSize * 0.3);
  ctx.save();
  ctx.translate(x + jx, y + jy);
  ctx.rotate((rnd() - 0.5) * 0.03);
  ctx.globalAlpha = (0.85 + rnd() * 0.15) * alphaScale;
  ctx.drawImage(spr, -pad, -pad - b.fontSize, spr.width / 2, spr.height / 2);
  if (colorOverride) {
    // 彩色重点词：偏移复描一遍 → 更粗更醒目
    ctx.globalAlpha = 0.4 * alphaScale;
    ctx.drawImage(spr, -pad + 1, -pad - b.fontSize + (rnd() - 0.5) * 0.8, spr.width / 2, spr.height / 2);
  }
  ctx.restore();
  ctx.globalAlpha = 1;
}

// ---------- 文本排版（区域流式 / 确定性） ----------

function fontString(b) {
  return `${b.fontSize}px ${FONT_STACK}`;
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

function newPage() {
  return { titleBlock: null, summaryBlock: null, regions: [], blocks: [], headers: [], animated: false, _laid: false, _dividers: [], _drawOrder: [] };
}

// 页面级确定性排版：区域钳制 → 分隔线 → 标题居中 → 区内流式 → 总结置底
function layoutPage(page) {
  if (page._laid) return;
  page._laid = true;
  const regs = page.regions.map((r) => {
    const x = clampNum(r.x, 40, W - 240);
    const y = clampNum(r.y, 130, H - 220);
    return {
      id: r.id,
      header: r.header,
      x,
      y,
      w: clampNum(r.width, 200, W - 40 - x),
      h: clampNum(r.height, 120, H - 40 - y),
    };
  });
  page._regions = regs;

  // 相邻区域之间的粉笔分隔线（左右相邻→竖线；上下相邻→横线）
  page._dividers = [];
  for (let i = 0; i < regs.length; i++) {
    for (let j = i + 1; j < regs.length; j++) {
      const A = regs[i];
      const B = regs[j];
      const ovX = Math.min(A.x + A.w, B.x + B.w) - Math.max(A.x, B.x);
      const ovY = Math.min(A.y + A.h, B.y + B.h) - Math.max(A.y, B.y);
      if (ovX > Math.min(A.w, B.w) * 0.5 && ovY <= 0) {
        // 上下相邻：横线画在（下区域顶 + 上区域底）/2 —— 两区不重叠时这是间隙中点
        const yTop = Math.max(A.y, B.y);
        const yBot = Math.min(A.y + A.h, B.y + B.h);
        if (yTop - yBot < 180) {
          const y = (yTop + yBot) / 2;
          page._dividers.push({ a: { x: Math.max(A.x, B.x) + 10, y }, b: { x: Math.min(A.x + A.w, B.x + B.w) - 10, y } });
        }
      } else if (ovY > Math.min(A.h, B.h) * 0.5 && ovX <= 0) {
        // 左右相邻：竖线画在（右区域左 + 左区域右）/2
        const xLeft = Math.max(A.x, B.x);
        const xRight = Math.min(A.x + A.w, B.x + B.w);
        if (xLeft - xRight < 180) {
          const x = (xLeft + xRight) / 2;
          page._dividers.push({ a: { x, y: Math.max(A.y, B.y) + 10 }, b: { x, y: Math.min(A.y + A.h, B.y + B.h) - 10 } });
        }
      }
    }
  }

  // 页标题：居中大字
  if (page.titleBlock) {
    const t = page.titleBlock;
    t.fontSize = clampNum(t.fontSize || 72, 60, 88);
    t.width = W - 200;
    computeLayout(t);
    textCtx.font = fontString(t);
    let tw = 0;
    for (const l of layouts.get(t.uid).lines) tw = Math.max(tw, textCtx.measureText(l).width);
    t.x = Math.max(40, (W - tw) / 2);
    t.y = 28;
  }

  // 区头（黄字带下划线）+ 区内块自上而下流式；字号不够放时自动缩小
  page.headers = [];
  const byRegion = new Map();
  for (const b of page.blocks) {
    if (!b.region) continue;
    if (!byRegion.has(b.region)) byRegion.set(b.region, []);
    byRegion.get(b.region).push(b);
  }
  for (const r of regs) {
    let cursorY = r.y + 14;
    if (r.header) {
      const hb = {
        uid: `h${++uidSeq}`,
        kind: "header",
        text: r.header,
        x: r.x + 24,
        y: cursorY,
        width: r.w - 48,
        fontSize: 45,
        color: "#ffe066",
        emphasis: [],
      };
      computeLayout(hb);
      page.headers.push(hb);
      cursorY += layouts.get(hb.uid).lineH + 12;
    }
    for (const b of byRegion.get(r.id) || []) {
      b.fontSize = clampNum(b.fontSize || 45, 36, 63);
      b.x = r.x + 24;
      b.width = r.w - 48;
      for (let tries = 0; tries < 4; tries++) {
        computeLayout(b);
        const lay = layouts.get(b.uid);
        if (cursorY + lay.lines.length * lay.lineH <= r.y + r.h - 6 || b.fontSize <= 32) break;
        b.fontSize = Math.max(32, Math.round(b.fontSize * 0.9));
      }
      b.y = cursorY;
      const lay = layouts.get(b.uid);
      cursorY += lay.lines.length * lay.lineH + 16;
    }
  }

  // 无区域归属的绝对块（AI 解答追加 / 旧协议）：仅钳制字号
  for (const b of page.blocks) {
    if (b.region) continue;
    b.fontSize = clampNum(b.fontSize || 42, 36, 63);
    if (!layouts.has(b.uid)) computeLayout(b);
  }

  // 总结句：置底换色
  if (page.summaryBlock) {
    const s = page.summaryBlock;
    s.fontSize = clampNum(s.fontSize || 48, 42, 56);
    s.x = 80;
    s.width = W - 160;
    computeLayout(s);
    const lay = layouts.get(s.uid);
    s.y = H - 64 - lay.lines.length * lay.lineH;
  }

  // 动画/绘制顺序：标题 → (逐区域：区头+内容) → 其余绝对块 → 总结
  const order = [];
  if (page.titleBlock) order.push(page.titleBlock);
  for (const r of regs) {
    for (const hb of page.headers) if (hb.text === r.header && hb.x === r.x + 24) order.push(hb);
    for (const b of byRegion.get(r.id) || []) order.push(b);
  }
  for (const b of page.blocks) if (!b.region) order.push(b);
  if (page.summaryBlock) order.push(page.summaryBlock);
  page._drawOrder = order.filter((b) => b._chars > 0);
}

// ---------- 重点标记（圈选 / 下划线） ----------

function drawChalkUnderline(ctx, x0, y, x1, chalkColor, rnd) {
  chalkSeg(ctx, x0, y, x1, y, chalkColor, 2.6, rnd);
}


// allowed: 已完整写出的字符数；partial: {gi, alpha} 正在渐现的字
function drawBlock(ctx, b, allowed, partial) {
  const lay = layouts.get(b.uid);
  if (!lay) return;
  ctx.font = fontString(b);
  // 便签（提问解释）：先贴一块与黑板底色一致的矩形框，字写在框内
  if (b.kind === "note" && allowed > 0) {
    let wMax = 0;
    for (const l of lay.lines) wMax = Math.max(wMax, ctx.measureText(l).width);
    const bx = b.x - 18;
    const by = b.y - 8;
    const bw = Math.min(b.width, wMax) + 36;
    const bh = lay.lines.length * lay.lineH + 14;
    ctx.save();
    ctx.globalAlpha = Math.min(1, allowed / 2 + 0.35); // 前两个字内淡入贴框
    ctx.fillStyle = THEMES[theme].base;
    ctx.fillRect(bx, by, bw, bh);
    ctx.globalAlpha = 0.6;
    ctx.strokeStyle = "#f2f0e6";
    ctx.lineWidth = 2;
    ctx.setLineDash([12, 9]);
    ctx.strokeRect(bx, by, bw, bh);
    ctx.setLineDash([]);
    ctx.restore();
  }
  let drawn = 0;
  for (let li = 0; li < lay.lines.length; li++) {
    const line = lay.lines[li];
    // 该行重点词的字符级颜色覆盖（重点 = 行内换彩色粉笔）
    const cover = new Array(line.length).fill(null);
    for (const em of b.emphasis ?? []) {
      const idx = line.indexOf(em.text);
      if (idx >= 0) {
        for (let k = idx; k < idx + em.text.length && k < line.length; k++) cover[k] = em.color;
      }
    }
    let x = b.x;
    const yBase = b.y + li * lay.lineH + b.fontSize * 0.9;
    let ci = 0;
    for (const ch of line) {
      if (drawn >= allowed) {
        if (partial && partial.gi === drawn && partial.alpha > 0.02) {
          chalkChar(ctx, ch, x, yBase, b, mulberry32(hashStr(b.uid) + drawn * 7919), partial.alpha, cover[ci]);
        }
        return;
      }
      chalkChar(ctx, ch, x, yBase, b, mulberry32(hashStr(b.uid) + drawn * 7919), 1, cover[ci]);
      x += ctx.measureText(ch).width;
      drawn++;
      ci++;
    }
  }
  // 标题/总结/区头写完 → 粉笔下划线
  if (allowed >= b._chars && (b.kind === "title" || b.kind === "summary" || b.kind === "header") && lay.lines.length > 0) {
    let wMax = 0;
    for (const l of lay.lines) wMax = Math.max(wMax, ctx.measureText(l).width);
    if (wMax > 30) {
      const uy = b.y + (lay.lines.length - 1) * lay.lineH + b.fontSize * 1.28;
      drawChalkUnderline(ctx, b.x, uy, b.x + wMax, b.color, mulberry32(hashStr(b.uid + "__u")));
    }
  }
}

// ---------- 渲染（t = 动画时间线毫秒；Infinity = 全部完成） ----------

function renderText(t = Infinity) {
  textCtx.setTransform(1, 0, 0, 1, 0, 0);
  textCtx.clearRect(0, 0, textC.width, textC.height);
  logicalTransform(textCtx, textC);
  textCtx.textBaseline = "alphabetic";

  const page = pages[curPage];
  if (!page) return;
  layoutPage(page);

  // 分隔线（按时间线渐进画线）
  for (const d of page._dividers) {
    let frac = 1;
    if (animState && t !== Infinity) {
      const e = animState.dividerMap.get(d);
      // 本次动画不含该线（如 AI 解答追加）→ 之前已画过，保持完整
      if (e) {
        frac = Math.max(0, Math.min(1, (t - e.t0) / e.cost));
        if (frac <= 0) continue;
      }
    }
    const rnd = mulberry32(hashStr(`${Math.round(d.a.x)},${Math.round(d.a.y)}`));
    chalkSeg(textCtx, d.a.x, d.a.y, d.a.x + (d.b.x - d.a.x) * frac, d.a.y + (d.b.y - d.a.y) * frac, "#d8d5c8", 2.6, rnd);
  }

  // 各块配额 = 已完整写出的字符数；正在写的字带渐现 alpha
  const quota = new Map();
  const partials = new Map();
  if (animState && t !== Infinity) {
    for (const e of animState.entries) {
      if (e.kind !== "char") continue;
      const done = t >= e.t0 + e.cost;
      const inFlight = !done && t >= e.t0;
      if (done) quota.set(e.b.uid, (quota.get(e.b.uid) ?? 0) + 1);
      else if (inFlight) partials.set(e.b.uid, { gi: e.gi, alpha: Math.max(0.1, (t - e.t0) / e.cost) });
    }
  }
  for (const b of page._drawOrder) {
    const allowed = quota.size ? (quota.get(b.uid) ?? Infinity) : Infinity; // 不在本次动画里的块始终完整显示
    drawBlock(textCtx, b, allowed, partials.get(b.uid));
  }

  // 讲解标记：讲到哪个词，就当场在板书上圈/划它（340ms 画完，保留）
  for (const mk of page._sayMarks || []) {
    const frac = animState && t !== Infinity ? Math.min(1, Math.max(0, (t - mk.tAppear) / 340)) : 1;
    if (frac <= 0) continue;
    drawSayMark(textCtx, mk, frac);
  }

}

// ---------- 时间线动画：分隔线 → 逐字渐现 ----------

function stopAnim() {
  if (animRaf) cancelAnimationFrame(animRaf);
  animRaf = 0;
  animState = null;
}

function animateIn(page, blockList, withDividers) {
  stopAnim();
  layoutPage(page);
  const entries = [];
  if (withDividers) {
    for (const d of page._dividers) entries.push({ kind: "divider", d });
  }
  let charCount = 0;
  for (const b of blockList) {
    const lay = layouts.get(b.uid);
    if (!lay) continue;
    for (let li = 0; li < lay.lines.length; li++) {
      for (let ci = 0; ci < lay.lines[li].length; ci++) {
        entries.push({ kind: "char", b, li, ci, gi: charCount, lineStart: ci === 0 });
        charCount++;
      }
    }
    charCount = 0; // gi 为块内序号
  }
  const charMs = entries.filter((e) => e.kind === "char").length > 220 ? CHAR_MS_FAST : CHAR_MS;
  let t = 0;
  for (const e of entries) {
    e.t0 = t;
    e.cost = e.kind === "divider" ? DIVIDER_MS : charMs + (e.lineStart && t > 0 ? LINE_PAUSE : 0);
    t += e.cost;
  }
  if (!entries.length) {
    renderText();
    return;
  }
  runTimeline(
    entries,
    new Map(entries.filter((e) => e.kind === "divider").map((e) => [e.d, e])),
    t,
    null,
  );
}

// 时间线驱动：onDone 仅在自然播完时回调（被 stopAnim 打断时不回调）
function runTimeline(entries, dividerMap, dur, onDone) {
  animState = { entries, dividerMap, dur, startTs: 0, tNow: 0, onDone };
  const frame = (ts) => {
    if (!animState) return;
    if (!animState.startTs) animState.startTs = ts;
    animState.tNow = ts - animState.startTs;
    renderText(animState.tNow);
    if (animState.tNow < animState.dur) {
      animRaf = requestAnimationFrame(frame);
    } else {
      animRaf = 0;
      animState = null;
      renderText();
      if (onDone) onDone();
    }
  };
  animRaf = requestAnimationFrame(frame);
}

const NARRATE_WRITE_MS = 80; // 讲解模式：快写节奏（教师写字不出声，写完再讲）

// ---------- 配音讲解（讲写协同：讲什么写什么，讲完才写下一块） ----------

let audioCtx = null;
const narration = { playing: false, seq: 0, timers: [], audios: [] };

function setNarrateBtn() {
  const b = $("#btn-narrate");
  if (b) {
    b.textContent = narration.playing ? "⏹ 停止" : "🔊 讲解";
    b.classList.toggle("primary", !narration.playing);
  }
  // 当前教师在讲解时浮动说话
  for (const t of ["female", "male"]) {
    const el = $(`#teacher-${t}`);
    if (el) el.classList.toggle("speaking", narration.playing && teacher === t);
  }
}

function stopNarration() {
  narration.seq++; // 使旧闭包失效
  narration.playing = false;
  for (const t of narration.timers) clearTimeout(t);
  narration.timers = [];
  for (const a of narration.audios) {
    try {
      a.pause();
      a.currentTime = 0;
    } catch {
      /* ignore */
    }
  }
  narration.audios = [];
  setNarrateBtn();
}

// 教师与音色（基音实测：alex 122Hz 男声 / anna 236Hz 女声）
const TEACHER_VOICES = {
  female: "FunAudioLLM/CosyVoice2-0.5B:anna",
  male: "FunAudioLLM/CosyVoice2-0.5B:alex",
};
let teacher = "female";

function setTeacher(t) {
  if (!TEACHER_VOICES[t] || teacher === t) return;
  teacher = t;
  $("#teacher-female").classList.toggle("active", t === "female");
  $("#teacher-male").classList.toggle("active", t === "male");
  toast(t === "female" ? "已切换：李老师（女声）" : "已切换：王老师（男声）", "");
}

$("#teacher-female").addEventListener("pointerdown", (e) => {
  e.stopPropagation();
  setTeacher("female");
});
$("#teacher-male").addEventListener("pointerdown", (e) => {
  e.stopPropagation();
  setTeacher("male");
});

// 讲稿标记解析：circle{词}/underline{词} → 纯文本 + 标记位置（转语音前剥离）
function parseSay(say) {
  const src = String(say || "");
  const re = /(circle|underline)\{([^{}]*)\}/g;
  let clean = "";
  const marks = [];
  let last = 0;
  let m;
  while ((m = re.exec(src))) {
    clean += src.slice(last, m.index);
    const start = clean.length;
    clean += m[2];
    if (m[2]) marks.push({ type: m[1], text: m[2], start, end: clean.length });
    last = re.lastIndex;
  }
  clean += src.slice(last);
  return { clean, marks };
}

// 取一块的语音（按当前教师音色缓存，讲稿剥离标记后送 TTS）：无讲稿/失败时返回静音降级
async function fetchVoice(b) {
  if (b._voice && b._voice.voice === teacher) return b._voice;
  const parsed = parseSay(b.say);
  const say = parsed.clean.trim();
  const fallback = { voice: teacher, el: null, dur: Math.max(1.5, (say || b.text).length * 0.19) };
  if (!say) {
    b._voice = fallback;
    return fallback;
  }
  try {
    const res = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: say, voice: TEACHER_VOICES[teacher] }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);
    const ab = await (await fetch(data.audio)).arrayBuffer();
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    let dur = 0;
    try {
      dur = await audioCtx.decodeAudioData(ab).then((x) => x.duration);
    } catch {
      /* 解码失败走估算 */
    }
    const el = new Audio(data.audio);
    el.preload = "auto";
    b._voice = { voice: teacher, el, dur: dur || fallback.dur };
  } catch {
    b._voice = fallback;
  }
  return b._voice;
}

// 讲稿标记 → 板书定位 + 出现时刻（词起点占纯讲稿比例 × 语音时长）
function pushSayMarks(page, b, windowStart, windowDur, mode) {
  const parsed = parseSay(b.say);
  const cleanLen = Math.max(1, parsed.clean.length);
  for (const mk of parsed.marks) {
    const span = findMarkSpan(b, mk.text);
    if (!span) continue; // 板书上找不到该词 → 无法定位，跳过
    page._sayMarks.push({ type: mk.type, text: mk.text, tAppear: windowStart + (mk.start / cleanLen) * windowDur, span });
  }
}

// 在块的板书行内找词的像素跨度
function findMarkSpan(b, text) {
  const lay = layouts.get(b.uid);
  if (!lay || !text) return null;
  textCtx.font = fontString(b);
  for (let li = 0; li < lay.lines.length; li++) {
    const line = lay.lines[li];
    const idx = line.indexOf(text);
    if (idx < 0) continue;
    const x0 = b.x + textCtx.measureText(line.slice(0, idx)).width;
    const x1 = x0 + textCtx.measureText(text).width;
    return { x0, x1, y: b.y + li * lay.lineH + b.fontSize * 0.9, fontSize: b.fontSize };
  }
  return null;
}

// 手绘粉笔圈（frac: 0~1 渐进画弧）
function drawChalkCircle(ctx, cx, cy, rx, ry, chalkColor, rnd, frac = 1) {
  ctx.strokeStyle = chalkColor;
  ctx.lineCap = "round";
  for (let pass = 0; pass < 2; pass++) {
    ctx.globalAlpha = 0.6 + rnd() * 0.28;
    ctx.lineWidth = 2.4 + rnd() * 1.6;
    const a0 = rnd() * Math.PI * 2;
    ctx.beginPath();
    ctx.ellipse(
      cx + (rnd() - 0.5) * 3,
      cy + (rnd() - 0.5) * 3,
      Math.max(10, rx + (rnd() - 0.5) * 7),
      Math.max(9, ry + (rnd() - 0.5) * 6),
      (rnd() - 0.5) * 0.15,
      a0,
      a0 + Math.PI * 1.92 * frac,
    );
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function drawSayMark(ctx, mk, frac) {
  const rnd = mulberry32(hashStr(mk.text + "|" + mk.type));
  if (mk.type === "circle") {
    drawChalkCircle(
      ctx,
      (mk.span.x0 + mk.span.x1) / 2,
      mk.span.y - mk.span.fontSize * 0.3,
      (mk.span.x1 - mk.span.x0) / 2 + 7,
      mk.span.fontSize * 0.55,
      "#ff9ec4",
      rnd,
      frac,
    );
  } else {
    const xEnd = mk.span.x0 + (mk.span.x1 - mk.span.x0) * frac; // 渐进划线
    drawChalkUnderline(ctx, mk.span.x0, mk.span.y + mk.span.fontSize * 0.12, xEnd, "#ffe066", rnd);
  }
}

// blocks 默认整页；逐块：块内写字均布在语音时长内，语音停 → 下一块才开写
async function playNarration(page, blockList) {
  stopNarration();
  stopAnim();
  layoutPage(page);
  const seq = narration.seq;
  const blocks = (blockList || page._drawOrder).filter((b) => layouts.has(b.uid));
  if (!blocks.length) return;
  narration.playing = true;
  setNarrateBtn();
  const voices = await Promise.all(blocks.map(fetchVoice));
  // 讲稿标记（circle/underline）：随语音讲到该词时画到板书上；重播则重建
  page._sayMarks = blockList ? page._sayMarks || [] : [];

  if (seq !== narration.seq) return; // 等待期间被停止

  const entries = [];
  const dividerMap = new Map();
  let t = 350;
  for (const d of page._dividers) {
    if (blockList) break; // 追加讲解不重画分隔线
    const e = { kind: "divider", d, t0: t, cost: DIVIDER_MS };
    entries.push(e);
    dividerMap.set(d, e);
    t += DIVIDER_MS + 150;
  }
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const lay = layouts.get(b.uid);
    const v = voices[i];
    const start = t + 200; // 起笔前小留白
    const per = NARRATE_WRITE_MS;
    if (v.el) {
      // 有语音：教师习惯——写字不出声，快写完整块（80ms/字），写完再开口讲
      let charCount = 0;
      for (const line of lay.lines) charCount += line.length;
      const writeDur = Math.max(500, charCount * per);
      let gi = 0;
      for (let li = 0; li < lay.lines.length; li++) {
        for (let ci = 0; ci < lay.lines[li].length; ci++) {
          entries.push({ kind: "char", b, li, ci, gi, t0: start + gi * per, cost: per });
          gi++;
        }
      }
      const speakAt = start + writeDur + 200;
      narration.audios.push(v.el);
      narration.timers.push(
        setTimeout(() => {
          if (seq !== narration.seq) return;
          v.el.currentTime = 0;
          v.el.play().catch(() => {});
        }, speakAt),
      );
      pushSayMarks(page, b, start + writeDur + 200, v.dur * 1000, "speak");
      t = speakAt + v.dur * 1000 + 450; // 讲完、缓冲，才轮到写下一块
    } else {
      // 无语音（未开配音/无讲稿）：不讲解；逐行快写，行尾按 5 字/秒 阅读速度停 1~3 秒
      let cursor = start;
      for (let li = 0; li < lay.lines.length; li++) {
        const line = lay.lines[li];
        let gi = 0;
        for (let ci = 0; ci < line.length; ci++) {
          entries.push({ kind: "char", b, li, ci, gi, t0: cursor + gi * per, cost: per });
          gi++;
        }
        cursor += Math.max(400, line.length * per); // 该行写完
        cursor += Math.min(3000, Math.max(1000, (line.length / 5) * 1000)); // 阅读停顿
      }
      pushSayMarks(page, b, start, cursor - start, "silent");
      t = cursor;
    }
  }
  runTimeline(entries, dividerMap, t + 250, () => {
    narration.playing = false;
    setNarrateBtn();
  });
}

$("#btn-narrate").addEventListener("click", () => {
  if (narration.playing) {
    stopNarration();
    renderText(); // 定格完整板书
  } else {
    playNarration(pages[curPage]);
  }
});

$("#btn-replay").addEventListener("click", () => {
  // 重播：从本页开头重新讲解（清标记重画）
  stopNarration();
  playNarration(pages[curPage]);
});

// ---------- 服务端板书 → 页面对象 ----------

function coerceEmphasisList(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((e) => e && typeof e.text === "string" && e.text.trim())
    .slice(0, 8)
    .map((e) => ({
      text: e.text.trim().slice(0, 20),
      color: /^#[0-9a-fA-F]{3,8}$/.test(e.color || "") ? e.color : "#ffe066",
    }));
}

function mkBlock(el, kind, defs) {
  if (!el || !el.text || !String(el.text).trim()) return null;
  return {
    uid: `u${++uidSeq}`,
    kind,
    text: String(el.text),
    x: typeof el.x === "number" ? el.x : defs.x,
    y: typeof el.y === "number" ? el.y : defs.y,
    width: typeof el.width === "number" ? el.width : defs.width,
    fontSize: typeof el.fontSize === "number" ? el.fontSize : defs.fontSize,
    color: /^#[0-9a-fA-F]{3,8}$/.test(el.color || "") ? el.color : defs.color,
    region: typeof el.region === "string" ? el.region : null,
    emphasis: coerceEmphasisList(el.emphasis),
    say: typeof el.say === "string" ? el.say.trim().slice(0, 400) : null, // 口播讲稿（配音用，与板书分离）
  };
}

function normalizePage(pg) {
  const page = newPage();
  if (!pg || typeof pg !== "object") return page;
  page.titleBlock = mkBlock(pg.title, "title", { x: 80, y: 28, width: W - 200, fontSize: 72, color: "#ffe066" });
  page.summaryBlock = mkBlock(pg.summary, "summary", { x: 80, y: H - 120, width: W - 160, fontSize: 48, color: "#ffe066" });
  if (Array.isArray(pg.regions)) {
    page.regions = pg.regions
      .filter((r) => r && typeof r === "object")
      .slice(0, 6)
      .map((r, i) => ({
        id: typeof r.id === "string" && r.id ? r.id : `r${i + 1}`,
        x: typeof r.x === "number" ? r.x : 60,
        y: typeof r.y === "number" ? r.y : 150,
        width: typeof r.width === "number" ? r.width : 700,
        height: typeof r.height === "number" ? r.height : 680,
        header: typeof r.header === "string" ? r.header.slice(0, 24) : null,
      }));
  }
  if (Array.isArray(pg.blocks)) {
    const ids = new Set(page.regions.map((r) => r.id));
    page.blocks = pg.blocks
      .map((b) => mkBlock(b, "block", { x: 80, y: 300, width: 640, fontSize: 45, color: "#f2f0e6" }))
      .filter(Boolean)
      .map((b) => {
        if (b.region && !ids.has(b.region)) b.region = page.regions[0]?.id ?? null;
        return b;
      });
  }
  return page;
}

// ---------- 翻页 ----------

function syncPageNav() {
  $("#page-indicator").textContent = `${curPage + 1} / ${pages.length}`;
  $("#btn-prev-page").disabled = curPage === 0;
  $("#btn-next-page").disabled = curPage >= pages.length - 1;
}

function goToPage(i) {
  if (i < 0 || i >= pages.length || i === curPage) return;
  stopNarration();
  stopAnim();
  renderText();
  curPage = i;
  syncPageNav();
  redrawStrokes();
  const p = pages[i];
  if (p._drawOrder.length && !p.animated) {
    p.animated = true;
    playNarration(p); // 每页首次观看 = 配音讲解 + 同步书写
  } else {
    renderText();
  }
}

$("#btn-prev-page").addEventListener("click", () => goToPage(curPage - 1));
$("#btn-next-page").addEventListener("click", () => goToPage(curPage + 1));

// ---------- 指针输入 ----------

let current = null;
let lastTap = null; // 手动双击检测（preventDefault 会抑制原生 dblclick）

boardEl.addEventListener("pointerdown", (e) => {
  if (e.pointerType === "mouse" && e.button !== 0) return;
  e.preventDefault();
  // 提问模式：点击 = 指着某行文字向 AI 提问，不落笔
  if (askMode) {
    handleAskClick(e);
    return;
  }
  // 书写动画中：左键单击 = 跳过动画，直接完整显示，且不留笔迹
  if (animState || narration.playing) {
    stopNarration();
    stopAnim();
    renderText();
    return;
  }
  const now = performance.now();
  // 双击黑板（500ms 内同位置两击）= 全屏：撤掉第一击的点，第二击不落笔
  if (lastTap && now - lastTap.t < 500 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 15) {
    lastTap = null;
    const s = strokesByPage[curPage];
    if (s.length && now - (s[s.length - 1]._t ?? 0) < 700) {
      s.pop();
      redrawStrokes();
    }
    toggleFullscreen();
    return;
  }
  lastTap = { t: now, x: e.clientX, y: e.clientY };
  boardEl.setPointerCapture(e.pointerId);
  const pt = toLogical(e);
  current = {
    tool,
    color,
    size: brushSize,
    seed: (seedSeq = (seedSeq + 0x9e3779b9) >>> 0),
    pts: [pt, { ...pt, x: pt.x + 0.01, y: pt.y + 0.01 }],
    _t: now,
  };
  strokesByPage[curPage].push(current);
  drawStrokeSegment(current, 1);
});

// ---------- 全屏（按钮 / 双击黑板） ----------

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch {
    /* 浏览器拒绝时静默 */
  }
}

$("#btn-fullscreen").addEventListener("click", toggleFullscreen);

boardEl.addEventListener("pointermove", (e) => {
  if (tool === "eraser") moveEraserCursor(e);
  if (!current) return;
  const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
  for (const ev of events.length ? events : [e]) {
    const pt = toLogical(ev);
    const last = current.pts[current.pts.length - 1];
    if (Math.hypot(pt.x - last.x, pt.y - last.y) < 0.8) continue;
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
  if (!s.length && !p._drawOrder.length) return;
  if (!confirm(`清空第 ${curPage + 1} 页黑板（手写 + AI板书）？`)) return;
  stopNarration();
  stopAnim();
  pages[curPage] = newPage();
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

function applyTheme() {
  $("#board-frame").style.background = THEMES[theme].frame;
  document.documentElement.style.setProperty("--bg", theme === "green" ? "#101b13" : "#12100e");
  paintBoard(bgCtx, bgC.width, bgC.height, theme);
}

$("#btn-theme").addEventListener("click", () => {
  theme = theme === "black" ? "green" : "black";
  applyTheme();
  toast(theme === "black" ? "经典黑板" : "护眼绿板", "");
});

$("#btn-export").addEventListener("click", exportPNG);

function exportPNG() {
  const scale = 2;
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
  } else if (e.key === "Escape" && askMode) {
    setAskMode(false);
  }
});

// ---------- 提问模式（指哪问哪：点击某行 → AI 就地便签解释） ----------

let askMode = false;

function setAskMode(on) {
  askMode = on;
  const b = $("#btn-ask");
  b.textContent = on ? "↩ 还原听课模式" : "🙋 我要问问题";
  b.classList.toggle("primary", on);
  boardEl.classList.toggle("ask-mode", on);
}

$("#btn-ask").addEventListener("click", () => setAskMode(!askMode));

// 找点击位置对应的板书行（横向命中的块优先，按行中心距离取最近）
function findLineAt(page, pt) {
  let best = null;
  let bestD = Infinity;
  for (const b of page._drawOrder) {
    const lay = layouts.get(b.uid);
    if (!lay) continue;
    const withinX = pt.x >= b.x - 60 && pt.x <= b.x + b.width + 120;
    for (let li = 0; li < lay.lines.length; li++) {
      if (!lay.lines[li].trim()) continue;
      const cy = b.y + li * lay.lineH + lay.lineH * 0.5;
      let d = Math.abs(pt.y - cy);
      if (!withinX) d += 800; // 不在本块横向范围内 → 强惩罚
      if (d < bestD) {
        bestD = d;
        best = { b, li, line: lay.lines[li] };
      }
    }
  }
  return bestD < 400 ? best : null;
}

async function handleAskClick(e) {
  if (narration.playing || animState) {
    stopNarration();
    stopAnim();
    renderText(); // 提问前先定格当前板书
  }
  const pt = toLogical(e);
  const page = pages[curPage];
  layoutPage(page);
  const hit = findLineAt(page, pt);
  if (!hit) return toast("没指到板书内容，请点在某行文字附近", "err");

  thinking(true, "AI 正在解答你指的问题…");
  try {
    const context = page._drawOrder
      .map((b) => b.text)
      .join("\n")
      .slice(0, 2000);
    const res = await fetch("/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ line: hit.line, context, x: Math.round(pt.x), y: Math.round(pt.y), canvasW: W, canvasH: H }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || `HTTP ${res.status}`);

    const note = mkBlock(
      { text: data.text, say: data.text, x: pt.x + 34, y: pt.y + 30, width: 460, fontSize: 30, color: "#ffe066" },
      "note",
      { x: pt.x + 34, y: pt.y + 30, width: 460, fontSize: 30, color: "#ffe066" },
    );
    computeLayout(note);
    const lay = layouts.get(note.uid);
    // 便签不出画布：右/下越界时往回收
    note.x = Math.min(note.x, W - note.width - 40);
    note.y = Math.min(note.y, H - lay.lines.length * lay.lineH - 60);
    page.blocks.push(note);
    page._drawOrder.push(note);
    playNarration(page, [note]); // 答案快写 + 教师开口讲解（其他板书保持不动）
  } catch (err) {
    toast(err.message.includes("Failed to fetch") ? "无法连接本地服务" : err.message, "err");
  } finally {
    thinking(false);
  }
}

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
      .map(normalizePage)
      .filter((p) => p._drawOrder.length > 0 || p.titleBlock || p.blocks.length || p.summaryBlock);
    // 计算最终 _drawOrder
    for (const p of newPages) layoutPage(p);
    const withContent = newPages.filter((p) => p._drawOrder.length > 0);
    if (!withContent.length) throw new Error("模型没有生成有效板书，请重试");
    stopAnim();
    pages = withContent;
    strokesByPage = pages.map(() => []);
    curPage = 0;
    syncPageNav();
    redrawStrokes();
    pages[0].animated = true;
    playNarration(pages[0]); // 生成即开讲：边讲边写
    $("#drawer").classList.add("hidden");
    toast(pages.length > 1 ? `板书已生成，共 ${pages.length} 页（←/→ 翻页）` : "板书已生成", "ok");
  } catch (err) {
    toast(err.message.includes("Failed to fetch") ? "无法连接本地服务" : err.message, "err");
  } finally {
    thinking(false);
  }
}

async function answerBoard() {
  const p = pages[curPage];
  if (!strokesByPage[curPage].length && !p._drawOrder.length) {
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
    const board = data.board || (data.pages || [])[0] || {};
    const appended = (board.blocks || [])
      .map((b) => mkBlock(b, "block", { x: 100, y: 700, width: 640, fontSize: 28, color: "#ffe066" }))
      .filter(Boolean);
    const extra = [];
    if (board.title) {
      const tb = mkBlock(board.title, "block", { x: 100, y: 640, width: 640, fontSize: 30, color: "#ffe066" });
      if (tb) extra.push(tb);
    }
    const blocks = extra.concat(appended);
    if (!blocks.length) throw new Error("模型没有返回作答内容，请重试");
    for (const b of blocks) computeLayout(b);
    p.blocks = p.blocks.concat(blocks);
    p._drawOrder = p._drawOrder.concat(blocks);
    if (blocks.some((b) => b.say && b.say.trim())) playNarration(p, blocks); // AI 解答也开口讲
    else animateIn(p, blocks, false);
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
    $("#cfg-ttsBaseUrl").value = cfg.ttsBaseUrl || "";
    $("#cfg-ttsApiKey").value = cfg.ttsApiKeyMasked || "";
    $("#cfg-ttsModel").value = cfg.ttsModel || "";
    $("#cfg-ttsVoice").value = cfg.ttsVoice || "";
    $("#cfg-status").textContent =
      cfg.hasKey && cfg.hasTtsKey
        ? "已配置 LLM + TTS 密钥"
        : cfg.hasKey
          ? "LLM 已配置；未配置 TTS，讲解将无配音"
          : "未配置密钥，AI 功能不可用";
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
    ttsBaseUrl: $("#cfg-ttsBaseUrl").value.trim(),
    ttsApiKey: $("#cfg-ttsApiKey").value.trim(),
    ttsModel: $("#cfg-ttsModel").value.trim(),
    ttsVoice: $("#cfg-ttsVoice").value.trim(),
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
  const fr = $("#board-frame").getBoundingClientRect();
  const availW = Math.max(100, fr.width - 32);
  const availH = Math.max(100, fr.height - 32);
  const s = Math.min(availW / W, availH / H);
  boardEl.style.width = `${Math.floor(W * s)}px`;
  boardEl.style.height = `${Math.floor(H * s)}px`;
  for (const c of [bgC, strokeC, textC]) fitCanvas(c);
  applyTheme();
  redrawStrokes();
  renderText(animState ? animState.tNow : Infinity);
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
