window.__APP_VER = 3; // 缓存自检标记：index.html 内联脚本据此判断 app.js 是否为旧缓存
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

let chalkGrain = 1.3; // 字体磨砂强度倍率（0 关闭 / 0.7 轻 / 1.3 标准 / 2.2 重）

// 板书字体预设：跨平台字体栈（mac / iOS / Windows / 安卓逐个命中）。
// 各端预装差异很大；部分环境（如这台 Mac 的 Safari 26）系统楷体名在网页里全部失效，
// 因此楷/行楷栈内嵌一层 CDN 开源楷体兜底（霞鹜文楷，切片 woff2 按需下载，本地命中时零流量）。
// initFontChoice()：用户保存的偏好永远生效；检测仅用于首次未配置时挑默认。
const FONT_PRESETS = [
  {
    id: "kaiti",
    label: "楷体",
    stack: `"Kaiti SC","STKaiti","Kaiti TC","楷体-简","楷体","KaiTi","BiauKai","AR PL UKai CN","LXGW WenKai","Noto Serif CJK SC",serif`,
    names: ["Kaiti SC", "STKaiti", "Kaiti TC", "楷体-简", "楷体", "KaiTi", "BiauKai", "AR PL UKai CN"],
  },
  {
    id: "xingkai",
    label: "行楷（手写风）",
    stack: `"Xingkai SC","STXingkai","行楷","Kaiti SC","Kaiti TC","楷体-简","KaiTi","BiauKai","LXGW WenKai Lite","Noto Serif CJK SC",serif`,
    names: ["Xingkai SC", "STXingkai", "行楷", "Kaiti SC", "Kaiti TC", "楷体-简", "KaiTi", "BiauKai"],
  },
  {
    id: "songti",
    label: "宋体",
    stack: `"Songti SC","STSong","宋体","SimSun","NSimSun","Noto Serif CJK SC","Source Han Serif SC",serif`,
    names: ["Songti SC", "STSong", "宋体", "SimSun", "NSimSun", "Noto Serif CJK SC", "Source Han Serif SC"],
  },
  {
    id: "heiti",
    label: "黑体",
    stack: `"PingFang SC","Heiti SC","Microsoft YaHei","微软雅黑","SimHei","黑体","Noto Sans CJK SC","Source Han Sans SC",sans-serif`,
    names: ["PingFang SC", "Heiti SC", "Microsoft YaHei", "微软雅黑", "SimHei", "黑体", "Noto Sans CJK SC", "Source Han Sans SC"],
  },
  {
    id: "yuanti",
    label: "圆体",
    stack: `"Yuanti SC","STYuan","圆体","YouYuan","幼圆","PingFang SC","Microsoft YaHei","Noto Sans CJK SC",sans-serif`,
    names: ["Yuanti SC", "STYuan", "圆体", "YouYuan", "幼圆"],
  },
  {
    id: "fangsong",
    label: "仿宋",
    stack: `"STFangsong","FangSong","仿宋","STFang","Noto Serif CJK SC",serif`,
    names: ["STFangsong", "FangSong", "仿宋", "STFang"],
  },
];
let fontChoice = "kaiti";

// 检测字体名在本机是否真实可用（宽度对比法：与任一通用族测宽不同 → 命中了真实字体）
let _fontAvailCache = null;
function fontAvailability() {
  if (_fontAvailCache) return _fontAvailCache;
  const avail = new Set();
  try {
    const c = document.createElement("canvas");
    const g = c.getContext("2d");
    const probeText = "永板书 chalk 123";
    const widthOf = (fontSpec) => {
      g.font = `72px ${fontSpec}`;
      return Math.round(g.measureText(probeText).width * 100);
    };
    const ref = new Map();
    for (const base of ["serif", "sans-serif", "monospace"]) ref.set(base, widthOf(base));
    const available = (name) => {
      const q = JSON.stringify(name);
      return ["serif", "sans-serif", "monospace"].some((base) => widthOf(`${q},${base}`) !== ref.get(base));
    };
    for (const p of FONT_PRESETS) for (const n of p.names) if (available(n)) avail.add(n);
  } catch {
    /* 检测失败 → 全部视为可用，行为与不检测一致 */
  }
  _fontAvailCache = avail;
  return avail;
}

// 选定字体：
// - 用户明确保存过的偏好永远被尊重（栈内逐名回退由引擎完成，检测仅用于提示）；
// - 首次使用（无保存值）→ 检测可用性选第一个命中的预设；
// - 保存值是无效 id → 回落 kaiti。
function initFontChoice(saved) {
  const pref = FONT_PRESETS.find((f) => f.id === saved);
  if (pref) {
    fontChoice = pref.id;
    return fontChoice;
  }
  const avail = fontAvailability();
  const has = (p) => p.names.some((n) => avail.has(n));
  fontChoice = (FONT_PRESETS.find(has) ?? FONT_PRESETS[0]).id;
  return fontChoice;
}

function applyGrain(v) {
  chalkGrain = Number.isFinite(Number(v)) ? Math.max(0, Math.min(2.5, Number(v))) : 1.3;
  spriteCache.clear(); // 字粒缓存含强度键，直接清空重生成
  relayout();
}

function fontStack() {
  return (FONT_PRESETS.find((f) => f.id === fontChoice) ?? FONT_PRESETS[0]).stack;
}

// webfont 就绪闸门：Safari 的 canvas 不会等待 @font-face 加载完成——字体未就绪时
// 逐字绘制的粉笔字粒会变成问号/空白并被永久缓存，且布局与绘制期度量不一致导致错位。
// 因此每次换字体后，等 webfont 真正就绪再整体失效重排一次。
let _fontGateSeq = 0;
function invalidateFontArtifacts() {
  spriteCache.clear();
  layouts.clear();
  for (const p of pages) p._laid = false;
  const figBlocks = [];
  for (const p of pages) for (const b of p.blocks) if (b.svg) { b._figure = null; figBlocks.push(b); }
  relayout();
  if (figBlocks.length) Promise.all(figBlocks.map(loadFigure)).then(() => relayout());
}
async function ensureFontsReady() {
  if (!document.fonts || !document.fonts.load) return;
  const seq = ++_fontGateSeq;
  // 必须带中文样本：CDN 楷体按 unicode-range 切片，默认只预载拉丁切片，
  // 中文切片不加载 → Safari canvas 不等 @font-face → 板书中文一直是 serif
  const sample = "板书讲义敲黑板重点关键数据公式定理";
  try {
    await Promise.race([
      Promise.all([document.fonts.load(`48px ${fontStack()}`, sample), document.fonts.ready]),
      new Promise((r) => setTimeout(r, 5000)), // CDN 不通最多等 5s，先按回退字体渲染
    ]);
  } catch {
    /* 加载失败按当前字体渲染 */
  }
  if (seq !== _fontGateSeq) return; // 期间又切了字体，交给新一轮
  invalidateFontArtifacts();
  // 超时兜底：5s 内 CDN 没到不永远放弃——webfont 真正就绪时再重排一次
  if (document.fonts.ready) {
    document.fonts.ready.then(() => {
      if (seq === _fontGateSeq) invalidateFontArtifacts();
    });
  }
}

// 切换字体：字粒缓存与排版全部失效，重排当前页。
// 用户显式选择的 id 永远生效（引擎按栈逐名回退）；未知 id 回落 kaiti。
function applyFont(id) {
  fontChoice = FONT_PRESETS.some((f) => f.id === id) ? id : initFontChoice(undefined);
  invalidateFontArtifacts();
  ensureFontsReady();
}

// ---------- 中/英双语：界面元素全量翻译；板书/语音/讲义由服务端按 lang 强制英文 ----------
let lang = "zh";
const tt = (zh, en) => (lang === "en" ? en : zh);

// [selector, 中文, English, mode]  mode: text=textContent / first=首个文本节点(label 含输入控件) / ph=placeholder
const UI_I18N = [
  ["#btn-layout", "输入素材", "Materials", "text"],
  ["#btn-replay", "重播", "Replay", "text"],
  ["#btn-ask", "问问题", "Ask", "text"],
  ["#btn-fullscreen", "全屏", "Full Screen", "text"],
  ["#btn-theme", "主题", "Theme", "text"],
  ["#btn-export", "截屏", "Capture", "text"],
  ["#btn-save-course", "保存", "Save", "text"],
  ["#btn-load-course", "加载", "Load", "text"],
  ["#btn-settings", "设置", "Settings", "text"],
  ["#drawer h2", "文本及图片 → 板书", "Text & Image → Board", "text"],
  ["#text-input", "粘贴文本…（可配合下方图片）", "Paste text… (images optional)", "ph"],
  ["#btn-image", "上传图像", "Upload Image", "text"],
  ["#btn-sample", "填入示例", "Sample", "text"],
  ["#btn-generate", "开始学习", "Start", "text"],
  [".brand-name", "敲黑板", "ChalkTalk", "text"],
  ["#btn-undo", "撤销", "Undo", "text"],
  ["#btn-clear", "清屏", "Clear", "text"],
  ["#answer-panel h2", "AI 解答", "AI Answer", "text"],
  ["#answer-panel .drawer-tip", "解答写在这块小黑板上，不影响左侧板书；点击可跳过书写。", "Answers appear on this side board without touching the main board; click to skip the writing.", "text"],
  ["#lecture-panel h2", "讲义", "Notes", "text"],
  ["#lecture-panel .drawer-tip", "老师口述内容实时记录，念一句多一句；颜色跟随对应板书块。", "The teacher's narration is transcribed live, one line at a time; colors follow the board blocks.", "text"],
  ["#settings-modal h2", "设置", "Settings", "text"],
  ['.mtab[data-tab="tab-llm"]', "模型服务", "Model Service", "text"],
  ['.mtab[data-tab="tab-tts"]', "配音 TTS", "TTS Voice", "text"],
  ['.mtab[data-tab="tab-look"]', "外观", "Appearance", "text"],
  ["#tab-llm label:nth-of-type(1)", "接口地址 baseUrl（OpenAI 兼容 /chat/completions）", "API base URL (OpenAI-compatible /chat/completions)", "first"],
  ["#tab-llm label:nth-of-type(2)", "API Key（留打码值表示不修改）", "API Key (keep masked value as-is)", "first"],
  ["#tab-llm label:nth-of-type(3)", "文本模型（板书排版）", "Text model (board layout)", "first"],
  ["#tab-llm label:nth-of-type(4)", "限流（次/分钟）", "Rate limit (req/min)", "first"],
  ["#tab-llm label:nth-of-type(5)", "禁用深度思考（大幅提速，模型不支持时自动忽略）", "Disable deep thinking (much faster; ignored if unsupported)", "first"],
  ["#tab-tts label:nth-of-type(1)", "接口地址（SiliconFlow 兼容 /audio/speech）", "Base URL (SiliconFlow-compatible /audio/speech)", "first"],
  ["#tab-tts label:nth-of-type(2)", "API Key（留打码值表示不修改）", "API Key (keep masked value as-is)", "first"],
  ["#tab-tts label:nth-of-type(3)", "模型", "Model", "first"],
  ["#tab-tts label:nth-of-type(4)", "讲解音色（男/女声预置）", "Narration voice (male/female presets)", "first"],
  ["#tab-look label:nth-of-type(1)", "板书字体", "Board font", "first"],
  ["#tab-look label:nth-of-type(2)", "字体磨砂感（粉笔颗粒强度）", "Chalk grain (texture strength)", "first"],
  ["#btn-cfg-save", "保存", "Save", "text"],
];
// 悬停提示（title 属性）翻译
const TITLE_I18N = [
  ["#btn-layout", "输入文字素材或拍张照片，AI 精炼排版为板书", "Feed text or a photo; AI lays it out as board writing"],
  ["#btn-narrate", "停止/继续 配音讲解", "Stop / resume narration"],
  ["#btn-replay", "从本页开头重新讲解", "Replay this page from the start"],
  ["#btn-ask", "进入提问模式：用鼠标指向黑板某行文字，AI 就地解释", "Ask mode: point at a line of board text for an in-place explanation"],
  ["#page-nav", "黑板翻页（←/→）", "Turn pages (←/→)"],
  ["#btn-prev-page", "上一页 (←)", "Previous page (←)"],
  ["#btn-next-page", "下一页 (→)", "Next page (→)"],
  ["#btn-fullscreen", "全屏黑板（也可双击黑板）", "Full screen (or double-click the board)"],
  ["#btn-theme", "切换黑板 / 绿板", "Toggle black / green board"],
  ["#btn-export", "截屏当前黑板为高清 PNG", "Capture the board as HD PNG"],
  ["#btn-save-course", "保存课程（板书+讲稿，纯文本 JSON）", "Save course (board + script, plain JSON)"],
  ["#btn-load-course", "加载课程文件，恢复板书与讲解", "Load a course file to restore board & narration"],
  ["#btn-settings", "设置（模型/配音/外观）", "Settings (model / voice / appearance)"],
  ["#btn-rail", "隐藏/显示左侧粉笔槽（投影时腾出更大黑板）", "Hide/show the chalk rail for a bigger board"],
  ["#btn-lang", "切换中文 / Switch to English", "切换中文 / Switch to English"],
  ["#chalk-rail", "粉笔槽", "Chalk rail"],
  ["#btn-eraser", "橡皮擦（板擦）", "Eraser"],
  ["#btn-undo", "撤销 (Ctrl/Cmd+Z)", "Undo (Ctrl/Cmd+Z)"],
  ["#btn-clear", "清空黑板", "Clear the board"],
  ["#btn-image", "拍照或从相册选图，题目图片会自动附解题过程", "Take a photo or pick one; problems get worked solutions"],
];
function applyLangUI() {
  for (const [sel, zh, en, mode] of UI_I18N) {
    const el = document.querySelector(sel);
    if (!el) continue;
    const s = lang === "en" ? en : zh;
    if (mode === "ph") el.placeholder = s;
    else if (mode === "first") {
      if (el.firstChild && el.firstChild.nodeType === Node.TEXT_NODE) el.firstChild.textContent = s;
    } else el.textContent = s;
  }
  for (const [sel, zh, en] of TITLE_I18N) {
    const el = document.querySelector(sel);
    if (el) el.title = lang === "en" ? en : zh;
  }
  setNarrateBtn();
  const rail = $("#chalk-rail");
  if (rail) $("#btn-rail").textContent = rail.classList.contains("rail-hidden") ? tt("显示粉笔", "Show Chalks") : tt("隐藏粉笔", "Hide Chalks");
  $("#btn-lang").textContent = lang === "en" ? "中文" : "EN";
  document.documentElement.lang = lang === "en" ? "en" : "zh-CN";
  document.title = lang === "en" ? "ChalkTalk" : "敲黑板";
}

$("#btn-lang").addEventListener("click", () => {
  lang = lang === "en" ? "zh" : "en";
  applyLangUI();
  fetch("api/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lang }) }).catch(() => {});
  toast(lang === "en" ? "Switched to English — new boards & narration will be in English" : "已切换为中文", "ok");
});

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
  const key = `${ch}|${fontSize}|${chalkColor}|${chalkGrain}`;
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
  g.font = `${fontSize}px ${fontStack()}`;
  g.textBaseline = "alphabetic";
  g.fillStyle = chalkColor;
  g.fillText(ch, pad, pad + fontSize);
  // 石膏磨砂：destination-out 打颗粒孔洞（确定性，动画不闪变）
  // 孔位从字形像素掩码采样——全部命中笔画（此前随机撒在全画布仅 ~19% 命中，效果弱）
  const rnd = mulberry32(hashStr(key));
  const W2 = c.width;
  const H2 = c.height;
  const glyph = g.getImageData(0, 0, W2, H2).data;
  const pts = [];
  for (let y = 0; y < H2; y += 2) {
    for (let x = 0; x < W2; x += 2) {
      if (glyph[(y * W2 + x) * 4 + 3] > 80) pts.push(x, y);
    }
  }
  const n = Math.round((pts.length / 8) * 0.5 * chalkGrain); // 按笔画面积定孔量（每2采样点≈1孔×强度）
  g.setTransform(1, 0, 0, 1, 0, 0); // 切设备坐标（pts 是设备像素；缩放坐标下会被再放大打偏）
  g.globalCompositeOperation = "destination-out";
  for (let i = 0; i < n && pts.length >= 4; i++) {
    const k = (rnd() * (pts.length / 2) | 0) * 2;
    g.globalAlpha = 0.2 + rnd() * 0.45;
    const s = (0.8 + rnd() * 1.4) * (0.7 + 0.3 * Math.min(2, chalkGrain));
    g.fillRect(pts[k] + (rnd() - 0.5) * 2, pts[k + 1] + (rnd() - 0.5) * 2, s, s);
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
  return `${b.fontSize}px ${fontStack()}`;
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
  // 显示层剥离 math{公式} 标记（保留公式内容）；TTS 转读在 fetchVoice 单独处理
  let display = b.text ? b.text.replace(/math\{([^{}]*)\}/g, "$1") : "";
  // 图题抑制（b._noCap：空间不足时保图舍题）：按空行处理，不参与换行与逐字书写
  if (b._noCap) display = "";
  const lines = display ? wrapText(textCtx, display, b.width) : [];
  layouts.set(b.uid, { lines, lineH: b.fontSize * 1.7 });
  b._chars = lines.reduce((n, l) => n + l.length, 0);
}

// 块占用的总高度（图 + 说明文字）
function blockHeight(b) {
  const lay = layouts.get(b.uid);
  const aspect = b._figure ? b._figure.aspect : 0.75;
  const hasCap = lay && lay.lines.length > 0;
  const figH = b.svg ? b.width * aspect + (hasCap ? 10 : 0) : 0;
  return figH + (lay ? lay.lines.length * lay.lineH : 0);
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

  // 分隔线在区域堆叠后基于最终几何计算（见下方）

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

  // 区内排版（可重复尝试）：返回每个区域的布局结果与内容底
  // 图先排（大件优先）；图宽按剩余高度换算，不固执下限；文字 fit 收字号
  const byRegion = new Map();
  for (const b of page.blocks) {
    if (!b.region) continue;
    if (!byRegion.has(b.region)) byRegion.set(b.region, []);
    byRegion.get(b.region).push(b);
  }
  // 图块尊重声明的 region（硬承诺）：Prompt 要求图独栏，LLM 把图分到哪个区就是哪个区，
  // 不参与文字的贪心流动——否则图会被拉回文字区下方缩成小图（语音说"右图"却画在左栏文字下）。
  // layFlow 内的 _figRegion 跳区逻辑负责实际入位。
  for (const b of page.blocks) {
    if (b.svg && b.region) b._figRegion = b.region;
  }
  // 违规兜底（与 9324580 旧方案的差异：只迁图、绝不迁文字——迁图不改变文字块的阅读顺序，
  // 不会引发旧方案「文字跨区重排 → 图文错页」的问题）：图与文字混在同区且存在完全空置区时，
  // 把图块移入空区。模型守规矩时（图已独栏）这里什么都不做。
  const figBlocks = page.blocks.filter((b) => b.svg && b.region);
  if (figBlocks.length) {
    const usedIds = new Set(page.blocks.filter((b) => !b.svg && b.region).map((b) => b.region));
    const emptyIds = page.regions.filter((r) => !usedIds.has(r.id)).map((r) => r.id);
    const mixed = figBlocks.filter((b) => usedIds.has(b.region));
    for (let i = 0; i < mixed.length && i < emptyIds.length; i++) {
      const list = byRegion.get(mixed[i].region);
      list.splice(list.indexOf(mixed[i]), 1);
      mixed[i].region = emptyIds[i];
      mixed[i]._figRegion = emptyIds[i]; // 强制 layFlow 直接送图入该区（图宽收敛按目标区宽度算）
      if (!byRegion.has(emptyIds[i])) byRegion.set(emptyIds[i], []);
      byRegion.get(emptyIds[i]).push(mixed[i]);
    }
  }
  const baseFonts = new Map(); // 每块原始字号（多轮收缩的基准）
  for (const b of page.blocks) baseFonts.set(b.uid, b.fontSize || 45);

  // 贪心流式装填：块按阅读顺序流动——当前区装不下（含图宽换算/文字缩字号到 30）就流入下一区，
  // 区用尽才整体收缩一档重来。彻底消除"单区爆满、邻区空闲"与溢出。
  const layFlow = (fontScale) => {
    const flowOrder = [...regs].sort((a, b) => a.y - b.y || a.x - b.x); // 阅读顺序：上行左→右，再下行
    if (!flowOrder.length) return { out: [], overflow: false }; // 无区域页：块走绝对定位分支
    const seq = [];
    const seen = new Set();
    for (const r of flowOrder) for (const b of byRegion.get(r.id) || []) { seq.push(b); seen.add(b.uid); }
    for (const b of page.blocks) if (b.region && !seen.has(b.uid)) { b.region = null; } // 引用不存在区域 → 绝对定位
    const outByRegion = new Map(regs.map((r) => [r.id, { r, headerLay: null, placed: [], contentH: 0 }]));
    let ri = 0;
    let cur = outByRegion.get(flowOrder[0].id);
    let cursorY = 0;
    const openRegion = () => {
      const r = cur.r;
      cursorY = 14;
      if (r.header) {
        const hb = { uid: `h${++uidSeq}`, kind: "header", text: r.header, x: r.x + 24, y: 0, width: r.w - 48, fontSize: Math.max(30, Math.round(45 * fontScale)), color: "#ffe066", emphasis: [] };
        computeLayout(hb);
        cur.headerLay = hb;
        cursorY += layouts.get(hb.uid).lineH + 12;
      }
    };
    const regionH = () => Math.max(cur.r.h, cursorY + 60);
    openRegion();
    let overflow = false;
    const assigned = new Map(); // 多轮收缩时记住上一轮的流动结果，同轮内保持一致
    const seededRegions = new Set();
    for (const b of seq) {
      if (assigned.has(b.uid)) {
        const r = assigned.get(b.uid);
        if (r !== cur.r.id && !seededRegions.has(r)) {
          // 上一轮已流到后续区：本轮流经中间区时按其已分配内容压住 cursor，避免再抢前区
          cur.contentH = cursorY;
          ri = flowOrder.findIndex((x) => x.id === r);
          cur = outByRegion.get(r);
          seededRegions.add(r);
          openRegion();
        }
        b.region = r;
      }
      b.fontSize = clampNum(Math.round(baseFonts.get(b.uid) * fontScale), 30, 63);
      b.x = cur.r.x + 24;
      let fits = false;
      let hops = 0; // 换区次数：文本最多 1 次；图可顺流到装得下的区（而非被硬性宽度顶出去）
      for (;;) {
        // 图独栏兜底标记：图已被指定到空区 → 直接跳到目标区再排版（图宽按目标区宽度收敛）
        if (b._figRegion && cur.r.id !== b._figRegion) {
          const ti = flowOrder.findIndex((x) => x.id === b._figRegion);
          if (ti >= 0) {
            cur.contentH = cursorY;
            ri = ti;
            cur = outByRegion.get(b._figRegion);
            b.region = cur.r.id;
            b.x = cur.r.x + 24;
            openRegion();
          }
        }
        const avail = regionH() - 6 - cursorY;
        if (b.svg) {
          const aspect = b._figure ? b._figure.aspect : 0.75;
          const maxW = Math.round((cur.r.w - 48) * Math.min(1, fontScale + 0.35));
          // 图内文字可读宽（有效字号≥20）只作软下限（取半）：曾用 Math.max 硬性顶回，
          // 图宽缩不下去 → fits 恒假 → 图被逐区外推到隔壁栏/尾区溢出
          const fig = b._figure;
          const wReadable = fig && fig.minFont && fig.vbW ? Math.ceil((20 * fig.vbW) / fig.minFont) : maxW;
          const wMin = Math.min(Math.max(140, Math.round(wReadable / 2)), maxW);
          // 图宽收敛：宽变 → 图题换行数变 → 高度约束变。单次估算曾因再换行失效（图窜栏根因之二）
          let w = maxW;
          let capH = 0;
          for (let i = 0; i < 4; i++) {
            b.width = w;
            computeLayout(b);
            const lay = layouts.get(b.uid);
            capH = lay.lines.length ? lay.lines.length * lay.lineH + 10 : 0;
            const wNext = clampNum(Math.floor((avail - capH) / aspect), wMin, maxW);
            if (wNext === w) break;
            w = wNext;
          }
          let fitsNow = avail >= w * aspect + capH;
          // 收敛后仍放不下 → 舍弃图题保图位（图题可无，图不可窜栏）
          if (!fitsNow) {
            const lay = layouts.get(b.uid);
            if (lay.lines.length) {
              b._noCap = true;
              computeLayout(b);
              b.width = clampNum(Math.floor(avail / aspect), wMin, maxW);
              fitsNow = avail >= b.width * aspect;
            }
          }
          fits = fitsNow;
        } else {
          b.width = cur.r.w - 48;
          computeLayout(b);
          for (let tries = 0; tries < 5; tries++) {
            if (cursorY + blockHeight(b) <= regionH() - 6) { fits = true; break; }
            if (b.fontSize <= 30) break;
            b.fontSize = Math.max(30, Math.round(b.fontSize * 0.88));
            computeLayout(b);
          }
        }
        if (fits) break;
        // 当前区放不下 → 开下一区
        if (ri < flowOrder.length - 1 && (hops < 1 || b.svg)) {
          cur.contentH = cursorY;
          ri += 1;
          cur = outByRegion.get(flowOrder[ri].id);
          b.region = cur.r.id;
          b.x = cur.r.x + 24;
          openRegion();
          hops++;
          continue;
        }
        // 区用尽：最后区内硬放；图收缩进剩余空间（宁小勿溢，防止压到别栏/总结条）
        overflow = true;
        if (b.svg) {
          const aspect = b._figure ? b._figure.aspect : 0.75;
          // 逐轮收敛：宽 → (图题行数变) → 高度约束 → 宽；两轮后仍放不下则舍图题、按纯图高定宽
          let room = regionH() - 6 - cursorY;
          for (let i = 0; i < 2; i++) {
            const l = layouts.get(b.uid);
            const capH = l.lines.length ? l.lines.length * l.lineH + 10 : 0;
            const wFit = Math.max(140, Math.floor((room - capH) / aspect));
            if (wFit >= b.width) break; // 已满足，别放大
            b.width = wFit;
            computeLayout(b);
          }
          {
            const l = layouts.get(b.uid);
            if (b.width * aspect + (l.lines.length ? l.lines.length * l.lineH + 10 : 0) > room && l.lines.length) {
              b._noCap = true;
              computeLayout(b);
              room = regionH() - 6 - cursorY;
              b.width = Math.max(140, Math.min(b.width, Math.floor(room / aspect)));
            }
          }
        }
        break;
      }
      assigned.set(b.uid, b.region);
      cur.placed.push({ b, dy: cursorY });
      cursorY += blockHeight(b) + 16;
    }
    cur.contentH = cursorY;
    // 未装填区域补零高
    for (const it of outByRegion.values()) if (!it.contentH) it.contentH = it.headerLay ? 60 : 10;
    const out = flowOrder.map((r) => outByRegion.get(r.id));
    return { out, overflow };
  };

  // 纵向堆叠：同列区域按阅读顺序顶 = 前区内容底 + 28，消除区域交叠
  const stackRegions = (laid, minTop) => {
    const origH = new Map(regs.map((r) => [r.id, r.h])); // 原始（钳制后）区域高，供保底计算
    let bottom = 0;
    for (let i = 0; i < laid.length; i++) {
      const it = laid[i];
      let top = Math.max(it.r.y, minTop);
      for (let j = 0; j < i; j++) {
        const prev = laid[j];
        const xOverlap = Math.min(prev.r.x + prev.r.w, it.r.x + it.r.w) - Math.max(prev.r.x, it.r.x);
        if (xOverlap > 40) top = Math.max(top, prev.r.y + prev.contentH + 28); // 同列纵向避让
      }
      it.r.y = top;
      if (it.headerLay) it.headerLay.y = top + (it.headerLay.y ?? 0);
      // 区域贴合内容高度；但内容已流走（本区被路过）时保底原高的 1/3，避免缩成一条细带
      it.r.h = Math.max(it.contentH + 10, origH.get(it.r.id) ? Math.round(origH.get(it.r.id) / 3) : 0);
      for (const p of it.placed) p.b.y = top + p.dy;
      bottom = Math.max(bottom, top + it.contentH);
    }
    return bottom;
  };

  const summaryTop = page.summaryBlock ? H - 150 : H - 60;
  const minTop = page.titleBlock ? 160 : 110; // 区域不得侵入标题带
  // stackRegions 会改写 r.y/r.h —— 多轮必须每轮从原始几何重来
  const origGeom = regs.map((r) => ({ y: r.y, h: r.h }));
  const resetGeom = () => regs.forEach((r, i) => { r.y = origGeom[i].y; r.h = origGeom[i].h; });
  let laid = null;
  let bottom = 0;
  const TOL = 24;
  const SCALES = [1, 0.93, 0.87, 0.8, 0.74, 0.68, 0.62];
  // 两轮尝试：先带总结条；内容实在装不下 → 去掉总结条再试（绝不重叠优先于保留总结）
  for (const pass of [0, 1]) {
    const sTop = page.summaryBlock ? H - 150 : H - 56;
    for (const s of SCALES) {
      resetGeom();
      const r = layFlow(s);
      laid = r.out;
      bottom = stackRegions(laid, minTop);
      if (!r.overflow && bottom <= sTop + TOL) break;
    }
    if (bottom <= sTop + TOL) break;
    if (pass === 0 && page.summaryBlock) {
      page.summaryBlock = null; // 牺牲总结条换空间
      continue;
    }
  }
  if (bottom > (page.summaryBlock ? H - 150 : H - 56) + TOL) {
    // 仍放不下（极端内容量）：整体上移（以最小区域顶算，绝不侵入标题带）
    const lift = Math.max(0, Math.min(bottom - (H - 56), Math.min(...laid.map((it) => it.r.y)) - minTop));
    for (const it of laid) {
      it.r.y -= lift;
      if (it.headerLay) it.headerLay.y -= lift;
      for (const p of it.placed) p.b.y -= lift;
    }
  }
  page.headers = laid.map((it) => it.headerLay).filter(Boolean);

  // 相邻区域之间的粉笔分隔线（左右相邻→竖线；上下相邻→横线）——用堆叠后的最终几何
  page._dividers = [];
  for (let i = 0; i < regs.length; i++) {
    for (let j = i + 1; j < regs.length; j++) {
      const A = regs[i];
      const B = regs[j];
      const ovX = Math.min(A.x + A.w, B.x + B.w) - Math.max(A.x, B.x);
      const ovY = Math.min(A.y + A.h, B.y + B.h) - Math.max(A.y, B.y);
      if (ovX > Math.min(A.w, B.w) * 0.5 && ovY <= 0) {
        const yTop = Math.max(A.y, B.y);
        const yBot = Math.min(A.y + A.h, B.y + B.h);
        if (yTop - yBot < 180) {
          const y = (yTop + yBot) / 2;
          page._dividers.push({ a: { x: Math.max(A.x, B.x) + 10, y }, b: { x: Math.min(A.x + A.w, B.x + B.w) - 10, y } });
        }
      } else if (ovY > Math.min(A.h, B.h) * 0.5 && ovX <= 0) {
        const xLeft = Math.max(A.x, B.x);
        const xRight = Math.min(A.x + A.w, B.x + B.w);
        if (xLeft - xRight < 180) {
          const x = (xLeft + xRight) / 2;
          page._dividers.push({ a: { x, y: Math.max(A.y, B.y) + 10 }, b: { x, y: Math.min(A.y + A.h, B.y + B.h) - 10 } });
        }
      }
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

  // 动画/绘制顺序：标题 → (逐区域按装填顺序：区头+块) → 其余绝对块 → 总结
  const order = [];
  if (page.titleBlock) order.push(page.titleBlock);
  for (const it of laid) {
    if (it.headerLay) order.push(it.headerLay);
    for (const p of it.placed) order.push(p.b);
  }
  for (const b of page.blocks) if (!b.region) order.push(b);
  if (page.summaryBlock) order.push(page.summaryBlock);
  page._drawOrder = order.filter((b) => b._chars > 0 || b.svg); // 纯图块（无字）也参与绘制与动画
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
  // 图示：按浮现进度画 SVG 图像（失败画 [图] 占位），说明文字排在图下方
  let yOff = 0;
  if (b.svg) {
    const fig = b._figure;
    const figH = fig ? b.width * fig.aspect : b.width * 0.75;
    if (fig && fig.img && allowed >= 0) {
      ctx.save();
      ctx.globalAlpha = 0.95 * (figAlphaMap.get(b.uid) ?? 1);
      ctx.drawImage(fig.img, b.x, b.y, b.width, figH);
      // 图内文字：loadFigure 剥离的 <text> 在主画布按当前字体栈绘制（img 内用不了 webfont）
      if (fig.texts && fig.texts.length) {
        const sc = b.width / (fig.vbW || 400);
        ctx.textBaseline = "alphabetic";
        for (const t of fig.texts) {
          if (!t.content) continue;
          ctx.font = `${t.weight ? t.weight + " " : ""}${Math.max(8, Math.round(t.size * sc))}px ${fontStack()}`;
          ctx.fillStyle = t.fill;
          ctx.textAlign = t.anchor === "middle" ? "center" : t.anchor === "end" ? "right" : "left";
          ctx.fillText(t.content, b.x + t.x * sc, b.y + t.y * sc);
        }
      }
      ctx.restore();
    } else if (allowed >= 0) {
      ctx.save();
      ctx.globalAlpha = 0.5 * (figAlphaMap.get(b.uid) ?? 1);
      ctx.fillStyle = b.color;
      ctx.font = fontString(b);
      ctx.fillText("[图]", b.x + b.width / 2 - b.fontSize, b.y + figH / 2);
      ctx.restore();
    }
    yOff = figH + (lay.lines.length ? 10 : 0);
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
    const yBase = b.y + yOff + li * lay.lineH + b.fontSize * 0.9;
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

let figAlphaMap = new Map(); // uid → 图示浮现进度（0~1），renderText 每帧重建

function renderText(t = Infinity) {
  textCtx.setTransform(1, 0, 0, 1, 0, 0);
  textCtx.clearRect(0, 0, textC.width, textC.height);
  logicalTransform(textCtx, textC);
  textCtx.textBaseline = "alphabetic";

  // 状态区分：讲解「预取语音中」→ 保持空白等待开讲，不显示全量文字
  // （提问模式/停止状态走 t=Infinity 全显，不受影响）
  if (narration.pending && !animState) return;

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

  // 各块配额 = 已完整写出的字符数；正在写的字带渐现 alpha；图块单独按 figure 条目浮现
  // 语义区分：在本次动画列表中的块按配额（未开写 = 0，不显示）；
  // 不在列表中的块（如提问便签追加讲解时的既有板书）始终完整显示。
  const quota = new Map();
  const partials = new Map();
  figAlphaMap = new Map();
  if (animState && t !== Infinity) {
    for (const e of animState.entries) {
      if (e.kind === "figure") {
        figAlphaMap.set(e.b.uid, Math.max(0, Math.min(1, (t - e.t0) / e.cost)));
        continue;
      }
      if (e.kind !== "char") continue;
      if (!quota.has(e.b.uid)) quota.set(e.b.uid, 0); // 先占位：动画块未开写也是 0
      const done = t >= e.t0 + e.cost;
      const inFlight = !done && t >= e.t0;
      if (done) quota.set(e.b.uid, quota.get(e.b.uid) + 1);
      else if (inFlight) partials.set(e.b.uid, { gi: e.gi, alpha: Math.max(0.1, (t - e.t0) / e.cost) });
    }
  }
  for (const b of page._drawOrder) {
    const allowed = quota.size ? (quota.get(b.uid) ?? Infinity) : Infinity;
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
    if (b.svg) entries.push({ kind: "figure", b }); // 图示浮现（700ms 淡入）
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
    e.cost = e.kind === "divider" ? DIVIDER_MS : e.kind === "figure" ? 700 : charMs + (e.lineStart && t > 0 ? LINE_PAUSE : 0);
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

// 时间线驱动：onDone 仅在自然播完时回调（被 stopAnim 打断时不回调）；onFrame 每帧驱动讲义区
function runTimeline(entries, dividerMap, dur, onDone, onFrame) {
  animState = { entries, dividerMap, dur, startTs: 0, tNow: 0, onDone };
  const frame = (ts) => {
    if (!animState) return;
    animState._lastFrame = performance.now();
    if (!animState.startTs) animState.startTs = ts;
    // 时钟防护：部分引擎在最小化恢复的首帧给 rAF 回退的时间戳（或 freeze 期间的积压帧），
    // tNow 倒退会让 quota 归零 → 板书瞬间清空。单调推进，永不低于上一帧。
    animState.tNow = Math.max(animState.tNow, ts - animState.startTs);
    renderText(animState.tNow);
    if (onFrame) onFrame(animState.tNow);
    if (animState.tNow < animState.dur) {
      animRaf = requestAnimationFrame(frame);
    } else {
      animRaf = 0;
      animState = null;
      renderText();
      if (onFrame) onFrame(Infinity);
      if (onDone) onDone();
    }
  };
  animRaf = requestAnimationFrame(frame);
  // 自愈：页面隐藏（最小化/切后台/冻结）期间 rAF 停摆，部分引擎恢复后不重投递已排队帧，
  // frame 链就此断裂——语音 setTimeout 照常触发而板书定格。恢复可见时强制续帧。
  const selfHeal = () => {
    if (!animState || !animRaf) return; // 已完结或已被打断
    animRaf = requestAnimationFrame(frame);
  };
  document.addEventListener("visibilitychange", selfHeal);
  // freeze 恢复（Safari 进程级挂起等场景）不触发 visibilitychange → 兜底轮询：
  // 每 2s 检查一次 animState 是否还活着但没在推进（tNow 停滞且页面可见）
  const watchdog = setInterval(() => {
    if (!animState) { clearInterval(watchdog); document.removeEventListener("visibilitychange", selfHeal); return; }
    if (document.visibilityState === "visible" && animRaf && performance.now() - (animState._lastFrame || 0) > 2500) selfHeal();
  }, 2000);
  const origOnDone = onDone;
  onDone = () => { clearInterval(watchdog); document.removeEventListener("visibilitychange", selfHeal); if (origOnDone) origOnDone(); };
  animState.onDone = onDone;
}

// ---------- 讲义区：老师口述实时记录（念一句，多一句） ----------

const lectureBody = $("#lecture-body");
let lectureQueue = []; // { text, at, color }
let lecturePtr = 0;

let lecturePanelHidden = false; // 用户显式关闭讲义后为 true：翻页/新页讲解不再强制弹出

function lectureReset(show) {
  lectureQueue = [];
  lecturePtr = 0;
  lectureBody.innerHTML = "";
  if (show && !lecturePanelHidden) $("#lecture-panel").classList.remove("hidden");
}

// 时间线每帧调用：把到点的话句追加进讲义区
function lectureTick(t) {
  while (lecturePtr < lectureQueue.length && lectureQueue[lecturePtr].at <= t) {
    const it = lectureQueue[lecturePtr++];
    const p = document.createElement("p");
    p.textContent = it.text;
    if (it.color) p.style.color = it.color;
    lectureBody.appendChild(p);
    lectureBody.scrollTop = lectureBody.scrollHeight; // 自动滚到最新
  }
}

// 把一段讲稿按句切分，按字符位置比例映射到语音时间窗
function pushLectureSay(b, windowStart, windowDur) {
  const parsed = parseSay(b.say);
  const clean = parsed.clean.trim();
  if (!clean) return;
  const cleanLen = Math.max(1, clean.length);
  const sentences = clean.match(/[^。！？!?；;\n]+[。！？!?；;]?/g) || [clean];
  let pos = 0;
  for (const s of sentences) {
    const start = pos;
    pos += s.length;
    const text = s.trim();
    if (text) lectureQueue.push({ text, at: windowStart + (start / cleanLen) * windowDur, color: b.color });
  }
}

$("#btn-lecture-close").addEventListener("click", () => {
  lecturePanelHidden = true;
  $("#lecture-panel").classList.add("hidden");
});

const NARRATE_WRITE_MS = 80; // 讲解模式：快写节奏（教师写字不出声，写完再讲）

// ---------- 配音讲解（讲写协同：讲什么写什么，讲完才写下一块） ----------

const narration = { playing: false, seq: 0, timers: [], audios: [] };

function setNarrateBtn() {
  const b = $("#btn-narrate");
  if (b) {
    b.textContent = narration.playing ? tt("停止", "Stop") : tt("讲解", "Narrate");
    b.classList.toggle("primary", !narration.playing);
  }
}

function stopNarration() {
  narration.seq++; // 使旧闭包失效
  narration.playing = false;
  narration.pending = false;
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
  lectureTick(Infinity); // 跳过讲解时讲义立即补全
  setNarrateBtn();
}

// 讲解音色（SiliconFlow CosyVoice2 全部预置音色，性别为基音实测）
const VOICE_LIST = [
  { id: "FunAudioLLM/CosyVoice2-0.5B:anna", label: "女声 · anna" },
  { id: "FunAudioLLM/CosyVoice2-0.5B:bella", label: "女声 · bella" },
  { id: "FunAudioLLM/CosyVoice2-0.5B:claire", label: "女声 · claire" },
  { id: "FunAudioLLM/CosyVoice2-0.5B:diana", label: "女声 · diana" },
  { id: "FunAudioLLM/CosyVoice2-0.5B:alex", label: "男声 · alex" },
  { id: "FunAudioLLM/CosyVoice2-0.5B:benjamin", label: "男声 · benjamin" },
  { id: "FunAudioLLM/CosyVoice2-0.5B:charles", label: "男声 · charles" },
  { id: "FunAudioLLM/CosyVoice2-0.5B:david", label: "男声 · david" },
];
let voiceId = VOICE_LIST[0].id;

// 设置页的音色/字体下拉一次性构建（顶栏不再放音色）
function buildSettingSelects() {
  const vs = $("#cfg-voice");
  if (!vs.options.length) {
    for (const v of VOICE_LIST) vs.add(new Option(v.label, v.id));
  }
  const fs = $("#cfg-font");
  if (!fs.options.length) {
    for (const f of FONT_PRESETS) fs.add(new Option(f.label, f.id));
  }
}

// 讲稿标记解析：circle{词}/underline{词} → 板书动作标记；math{...} → 公式段（TTS 直读不转"杠"）
function parseSay(say) {
  const src = String(say || "");
  const re = /(circle|underline|math)\{([^{}]*)\}/g;
  let clean = "";
  const marks = [];
  const segs = []; // {text, isMath} — TTS 转读用
  let last = 0;
  let m;
  while ((m = re.exec(src))) {
    if (m.index > last) segs.push({ text: src.slice(last, m.index), isMath: false });
    clean += src.slice(last, m.index);
    const start = clean.length;
    clean += m[2];
    segs.push({ text: m[2], isMath: m[1] === "math" });
    if (m[2] && m[1] !== "math") marks.push({ type: m[1], text: m[2], start, end: clean.length });
    last = re.lastIndex;
  }
  if (last < src.length) segs.push({ text: src.slice(last), isMath: false });
  clean += src.slice(Math.min(last, src.length));
  return { clean, marks, segs };
}

// TTS 朗读文本：公式段(math{})原样直读，普通文本把 - 读作"杠"
function ttsSpeech(parsed) {
  return (parsed.segs || [{ text: parsed.clean, isMath: false }])
    .map((s) => (s.isMath ? s.text : s.text.replace(/-/g, "杠")))
    .join("");
}

// 取一块的语音（按当前教师音色缓存，讲稿剥离标记后送 TTS）：无讲稿/失败时返回静音降级
async function fetchVoice(b) {
  if (b._voice && b._voice.voice === voiceId) return b._voice;
  const parsed = parseSay(b.say);
  const say = ttsSpeech(parsed).trim(); // 公式段直读，普通文本 - 读作"杠"
  const fallback = { voice: voiceId, el: null, dur: Math.max(1.5, (say || b.text).length * 0.19) };
  if (!say) {
    b._voice = fallback;
    return fallback;
  }
  try {
    const res = await fetch("api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: say, voice: voiceId }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);
    const el = new Audio(data.audio);
    el.preload = "auto";
    // 时长由 loadedmetadata 提供（不再用 AudioContext.decodeAudioData：
    // Safari 对未手势激活的 AudioContext 会挂起，曾导致整个配音链路静默失败）
    let dur = 0;
    await new Promise((resolve) => {
      const done = () => resolve(undefined);
      el.addEventListener("loadedmetadata", done, { once: true });
      el.addEventListener("error", done, { once: true });
      setTimeout(done, 8000);
      if (el.readyState >= 1) done();
    });
    dur = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : 0;
    b._voice = { voice: voiceId, el, dur: dur || fallback.dur };
  } catch (e) {
    b._voice = fallback;
    // TTS 不可用时明确告知（每次会话只提醒一次），避免误以为程序坏了
    if (!fetchVoice._warned) {
      fetchVoice._warned = true;
      toast(`配音不可用（${String(e && e.message ? e.message : "TTS 服务异常").slice(0, 60)}），已切换无声模式`, "err");
    }
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

// 在块的板书行内找词的像素跨度（图块：文字在图下方，行 y 必须加上图高偏移）
function findMarkSpan(b, text) {
  const lay = layouts.get(b.uid);
  if (!lay || !text) return null;
  textCtx.font = fontString(b);
  const yOff = b.svg ? b.width * (b._figure ? b._figure.aspect : 0.75) + (lay.lines.length ? 10 : 0) : 0;
  for (let li = 0; li < lay.lines.length; li++) {
    const line = lay.lines[li];
    const idx = line.indexOf(text);
    if (idx < 0) continue;
    const x0 = b.x + textCtx.measureText(line.slice(0, idx)).width;
    const x1 = x0 + textCtx.measureText(text).width;
    return { x0, x1, y: b.y + yOff + li * lay.lineH + b.fontSize * 0.9, fontSize: b.fontSize };
  }
  return null;
}

// 找点击位置对应的板书行（横向命中的块优先，按行中心距离取最近）
function findLineAt(page, pt) {
  let best = null;
  let bestD = Infinity;
  for (const b of page._drawOrder) {
    const lay = layouts.get(b.uid);
    if (!lay) continue;
    // 图块：文字行在图下方，行 y 加图高偏移（曾漏加 → 指行提问命中跑到图上）
    const yOff = b.svg ? b.width * (b._figure ? b._figure.aspect : 0.75) + (lay.lines.length ? 10 : 0) : 0;
    const withinX = pt.x >= b.x - 60 && pt.x <= b.x + b.width + 120;
    for (let li = 0; li < lay.lines.length; li++) {
      if (!lay.lines[li].trim()) continue;
      const cy = b.y + yOff + li * lay.lineH + lay.lineH * 0.5;
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

// 手绘粉笔圈（frac: 0~1 渐进画弧）
function drawChalkCircle(ctx, cx, cy, rx, ry, chalkColor, rnd, frac = 1) {
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

// Safari 静音策略：HTMLAudioElement 必须先在用户手势中成功 play 过一次，后续由定时器触发的
// play() 才允许出声（Chrome 无此限制）。手势入口统一在此解锁。
let audioUnlocked = false;
function unlockAudio() {
  if (audioUnlocked) return;
  audioUnlocked = true;
  try {
    const u = new Audio();
    u.muted = true;
    u.play().then(() => u.pause()).catch(() => {});
  } catch {
    /* 解锁尽力而为 */
  }
}

// blocks 默认整页；逐块：块内写字均布在语音时长内，语音停 → 下一块才开写
async function playNarration(page, blockList) {
  unlockAudio();
  stopNarration();
  stopAnim();
  layoutPage(page);
  const seq = narration.seq;
  const blocks = (blockList || page._drawOrder).filter((b) => layouts.has(b.uid));
  if (!blocks.length) return;
  narration.playing = true;
  narration.pending = !blockList; // 整页讲解预取语音时画面空白；追加讲解保持现有板书
  setNarrateBtn();
  await loadFigures(page); // 图先加载（结果不进 voices，曾因混入导致 voices 错位、时间线时长 NaN 秒完）
  const voices = await Promise.all(blocks.map(fetchVoice));
  // 讲稿标记（circle/underline）：随语音讲到该词时画到板书上；重播则重建
  page._sayMarks = blockList ? page._sayMarks || [] : [];

  if (seq !== narration.seq) return; // 等待期间被停止
  narration.pending = false; // 预取完成，时间线即将启动
  lectureReset(true); // 讲义区清空并显示，随讲解逐句追加

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
      const figDur = b.svg ? 700 : 0; // 图示先浮现 700ms
      const writeDur = Math.max(500, charCount * per) + figDur;
      if (b.svg) entries.push({ kind: "figure", b, t0: start, cost: 700 });
      let gi = 0;
      for (let li = 0; li < lay.lines.length; li++) {
        for (let ci = 0; ci < lay.lines[li].length; ci++) {
          entries.push({ kind: "char", b, li, ci, gi, t0: start + figDur + gi * per, cost: per });
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
      pushLectureSay(b, speakAt, v.dur * 1000); // 念到哪句，讲义多哪句
      t = speakAt + v.dur * 1000 + 450; // 讲完、缓冲，才轮到写下一块
    } else {
      // 无语音（未开配音/无讲稿）：不讲解；逐行快写，行尾按 5 字/秒 阅读速度停 1~3 秒
      let cursor = start;
      if (b.svg) {
        entries.push({ kind: "figure", b, t0: cursor, cost: 700 });
        cursor += 700;
      }
      for (let li = 0; li < lay.lines.length; li++) {
        const line = lay.lines[li];
        let gi = 0;
        for (let ci = 0; ci < line.length; ci++) {
          entries.push({ kind: "char", b, li, ci, gi, t0: cursor + gi * per, cost: per });
          gi++;
        }
      }
      pushSayMarks(page, b, start, cursor - start, "silent");
      pushLectureSay(b, start, cursor - start); // 无语音时按阅读窗口逐句出
      t = cursor;
    }
  }
  runTimeline(
    entries,
    dividerMap,
    t + 250,
    () => {
      narration.playing = false;
      setNarrateBtn();
      // 整页讲完 → 3 秒后自动连播下一页（点击/翻页/停止可打断：计时器入 narration.timers）
      if (!blockList && pages[curPage] === page && curPage < pages.length - 1) {
        const seq = narration.seq;
        narration.timers.push(
          setTimeout(() => {
            if (seq !== narration.seq) return;
            goToPage(curPage + 1);
          }, 3000),
        );
      }
    },
    lectureTick,
  );
}

$("#btn-narrate").addEventListener("click", () => {
  unlockAudio(); // Safari：必须点击当下解锁，异步回调里无效
  if (narration.playing) {
    stopNarration();
    renderText(); // 定格完整板书
  } else {
    playNarration(pages[curPage]);
  }
});

let replayLastAt = 0;
$("#btn-replay").addEventListener("click", () => {
  // 防抖：600ms 内重复点击忽略（快速双击曾造成预取竞态）
  unlockAudio();
  replayLastAt = Date.now();
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

function sanitizeSvg(s) {
  if (typeof s !== "string") return null;
  const t = s.trim();
  if (!t.startsWith("<svg") || !t.includes("</svg>") || t.length > 8000) return null;
  // 剥离 xmlns 命名空间声明后再查外链（w3.org 是 SVG 合法声明，不是外链）
  const noNs = t.replace(/xmlns(:\w+)?="http:\/\/www\.w3\.org\/[^"]*"/g, "").replace(/xmlns(:\w+)?='http:\/\/www\.w3\.org\/[^']*'/g, "");
  if (/<script|on\w+\s*=|javascript:|https?:\/\//i.test(noNs)) return null;
  // 缺命名空间则补上（Blob 渲染需要）
  return /xmlns=/.test(t) ? t : t.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"');
}

function mkBlock(el, kind, defs) {
  if (!el) return null;
  const svg = sanitizeSvg(el.svg);
  // 纯图块允许无 text（图 + 可选 caption）
  if ((!el.text || !String(el.text).trim()) && !svg) return null;
  return {
    uid: `u${++uidSeq}`,
    kind,
    text: el.text ? String(el.text).replace(/^\s*[【\[（(]\s*图\s*[】\]）)]\s*/u, "") : "", // 图注不带"【图】"前缀（板书习惯）
    x: typeof el.x === "number" ? el.x : defs.x,
    y: typeof el.y === "number" ? el.y : defs.y,
    width: typeof el.width === "number" ? el.width : defs.width,
    fontSize: typeof el.fontSize === "number" ? el.fontSize : defs.fontSize,
    color: /^#[0-9a-fA-F]{3,8}$/.test(el.color || "") ? el.color : defs.color,
    region: typeof el.region === "string" ? el.region : null,
    emphasis: coerceEmphasisList(el.emphasis),
    say: typeof el.say === "string" ? el.say.trim().slice(0, 400) : null, // 口播讲稿（配音用，与板书分离）
    svg,
  };
}

// SVG 黑板适配预处理：
// 1) 折线/多边形/路径等未声明 fill 时 SVG 默认黑色填充 → 根节点默认 fill="none" 根治黑底
// 2) <text> 未指定 fill 时补白粉笔色，避免被根默认值隐身
function prepSvgForBoard(svg) {
  let s = svg;
  const head = s.match(/^<svg[^>]*>/)?.[0] ?? "";
  if (!/\sfill=/.test(head)) s = s.replace(/<svg\b/, '<svg fill="none"');
  s = s.replace(/<text(?![^>]*\sfill=)/g, '<text fill="#f2f0e6"');
  s = s.replace(/<tspan(?![^>]*\sfill=)/g, '<tspan fill="#f2f0e6"');
  // 图内文字与板书同字体（未显式指定时注入当前字体栈；切字体时 applyFont 会重载图像）
  const ff = `font-family='${fontStack()}'`;
  s = s.replace(/<text(?![^>]*\sfont-family=)/g, `<text ${ff}`);
  s = s.replace(/<tspan(?![^>]*\sfont-family=)/g, `<tspan ${ff}`);
  return s;
}

// <img> 内的 SVG 既加载不了文档 webfont，data: 内嵌 @font-face 在多数引擎也不生效 → 图内文字曾回退宋体。
// 方案：把 <text> 元素从 SVG 剥离（图只留矢量线条），文字由主画布按当前字体栈绘制——
// 与板书正文字体完全一致，换字体即时生效。见 loadFigure / drawBlock。

async function loadFigure(b) {
  if (!b.svg || b._figure) return;
  const vb = b.svg.match(/viewBox=["']([\d.\s,-]+)["']/); // 兼容单/双引号
  let aspect = 0.75;
  let vbW = 400;
  if (vb) {
    const p = vb[1].split(/[\s,]+/).map(Number);
    if (p.length === 4 && p[2] > 0 && p[3] > 0) { aspect = p[3] / p[2]; vbW = p[2]; }
  }
  // 图内最小字号（无声明按提示词默认 16）——排版时据此保证文字实际显示尺寸
  const sizes = [...b.svg.matchAll(/font-size=["'](\d+(?:\.\d+)?)["']/g)].map((m) => Number(m[1]));
  const minFont = sizes.length ? Math.min(...sizes) : 16;
  b._figure = { aspect, vbW, minFont, img: null, texts: [] };
  try {
    let s = prepSvgForBoard(b.svg);
    // 剥离 <text>：记录位置/颜色/字号/锚点/内容，元素本体从 SVG 移除（主画布另行绘制）
    s = s.replace(/<text([^>]*)>([\s\S]*?)<\/text>/g, (_m, attrs, body) => {
      const num = (re, d) => {
        const mm = attrs.match(re);
        return mm ? parseFloat(mm[1]) : d;
      };
      const content = body.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
      if (content) {
        b._figure.texts.push({
          x: num(/x=["']([-?\d.]+)["']/, 0),
          y: num(/y=["']([-?\d.]+)["']/, 0),
          fill: (attrs.match(/fill=["']([^"']+)["']/) || [])[1] || "#f2f0e6",
          size: num(/font-size=["']([-?\d.]+)["']/, 20),
          anchor: (attrs.match(/text-anchor=["']([^"']+)["']/) || [])[1] || "start",
          weight: (attrs.match(/font-weight=["']([^"']+)["']/) || [])[1] || "",
          content,
        });
      }
      return "";
    });
    const url = URL.createObjectURL(new Blob([s], { type: "image/svg+xml;charset=utf-8" }));
    const img = new Image();
    img.src = url;
    await img.decode();
    b._figure.img = img;
  } catch {
    b._figure.img = null; // 失败 → 画「[图]」占位
  }
}

function loadFigures(page) {
  // 遍历 page.blocks（而非 _drawOrder）：生成流程在 layoutPage 之前调用，
  // 此时 _drawOrder 尚未构建 —— 之前因此漏载图，排版按 0 图高导致图文重叠
  return Promise.all((page.blocks || []).filter((b) => b.svg).map(loadFigure));
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

// 粉笔槽显隐：隐藏后黑板自动占据全宽（relayout 由 ResizeObserver 触发）
$("#btn-rail").addEventListener("click", () => {
  const rail = $("#chalk-rail");
  const hidden = rail.classList.toggle("rail-hidden");
  $("#btn-rail").textContent = hidden ? tt("显示粉笔", "Show Chalks") : tt("隐藏粉笔", "Hide Chalks");
  toast(hidden ? tt("粉笔槽已隐藏", "Chalk rail hidden") : tt("粉笔槽已显示", "Chalk rail shown"), "");
});

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
  if (!apPanel.classList.contains("hidden") && apCanvas.width > 1) apPaintStatic(apAnim ? Infinity : undefined);
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

// ---------- 课程保存 / 加载（只存大模型备课输出的纯文本：板书+讲稿+SVG+标记；音频/图像加载时重建） ----------

function courseBlockToJSON(b) {
  const o = { text: b.text };
  if (b.say) o.say = b.say;
  if (b.svg) o.svg = b.svg;
  if (b.fontSize) o.fontSize = b.fontSize;
  if (b.color) o.color = b.color;
  if (b.emphasis && b.emphasis.length) o.emphasis = b.emphasis;
  if (b.region) o.region = b.region;
  else {
    o.x = Math.round(b.x);
    o.y = Math.round(b.y);
    o.width = Math.round(b.width);
  }
  return o;
}

function saveCourse() {
  if (!pages.length || !pages.some((p) => p._drawOrder.length)) return toast("当前没有可保存的课程", "err");
  const data = {
    app: "敲黑板",
    version: 1,
    savedAt: new Date().toISOString(),
    pages: pages.map((p) => ({
      title: p.titleBlock ? courseBlockToJSON(p.titleBlock) : null,
      summary: p.summaryBlock ? courseBlockToJSON(p.summaryBlock) : null,
      regions: p.regions.map((r) => {
        const o = { id: r.id, x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
        if (r.header) o.header = r.header;
        return o;
      }),
      blocks: p.blocks.map(courseBlockToJSON),
    })),
  };
  const a = document.createElement("a");
  const ts = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
  const name = (pages[0].titleBlock?.text || "课程").slice(0, 12);
  a.download = `敲黑板-${name}-${ts}.json`;
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  a.click();
  toast(`课程已保存（${pages.length} 页，纯文本）`, "ok");
}

async function loadCourseFile(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!data || !Array.isArray(data.pages) || !data.pages.length) throw new Error("不是有效的课程文件");
    stopNarration();
    stopApAnim(false);
    apPanel.classList.add("hidden");
    lectureReset(false);
    lecturePanelHidden = false; // 新课程 = 新会话：重置用户对讲义面板的选择
    $("#lecture-panel").classList.add("hidden");
    const newPages = data.pages.map(normalizePage).filter((p) => p.titleBlock || p.blocks.length || p.summaryBlock);
    if (!newPages.length) throw new Error("课程文件里没有内容");
    await Promise.all(newPages.map(loadFigures)); // SVG 图示重新解析成图像
    for (const p of newPages) layoutPage(p);
    pages = newPages;
    strokesByPage = pages.map(() => []); // 课程不含手写涂鸦
    curPage = 0;
    syncPageNav();
    redrawStrokes();
    pages[0].animated = true;
    playNarration(pages[0]); // 语音按需重新合成（课程文件不含音频）
    toast(`课程已加载（${pages.length} 页），开始上课`, "ok");
  } catch (e) {
    toast(`加载失败：${e.message}`, "err");
  }
}

$("#btn-save-course").addEventListener("click", saveCourse);
$("#course-file").addEventListener("change", (e) => {
  const f = e.target.files && e.target.files[0];
  if (f) loadCourseFile(f);
  e.target.value = ""; // 允许重复选同一文件
});

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
  b.textContent = on ? tt("还原听课", "Lesson") : tt("问问题", "Ask");
  b.classList.toggle("primary", on);
  boardEl.classList.toggle("ask-mode", on);
  // 面板互斥：提问模式只看 AI 解答——隐藏讲义；还原听课时若讲解进行中则恢复讲义
  if (on) {
    $("#lecture-panel").classList.add("hidden");
  } else {
    stopApAnim(false);
    apPanel.classList.add("hidden");
    if (!lecturePanelHidden && (narration.playing || narration.pending)) $("#lecture-panel").classList.remove("hidden");
  }
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
  unlockAudio(); // Safari：解答面板配音同样需手势解锁
  if (narration.playing || animState) {
    stopNarration();
    stopAnim();
    renderText(); // 提问前先定格当前板书
  }
  const pt = toLogical(e);
  const page = pages[curPage];
  layoutPage(page);
  const hit = findLineAt(page, pt);
  if (!hit) return toast(tt("没指到板书内容，请点在某行文字附近", "Click near a line of board text"), "err");

  thinking(true, tt("AI 正在解答你指的问题…", "AI is answering…"));
  try {
    const context = page._drawOrder
      .map((b) => b.text)
      .join("\n")
      .slice(0, 2000);
    const res = await fetch("api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ line: hit.line, context, x: Math.round(pt.x), y: Math.round(pt.y), canvasW: W, canvasH: H, ...(lang === "en" ? { lang: "en" } : {}) }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || `HTTP ${res.status}`);

    // 答案写入右侧解答面板（新一问覆盖前一问）
    const blocks = [
      mkBlock({ text: data.text, say: data.text, x: 40, y: 200, width: 480, fontSize: 34, color: "#ffe066" }, "block", { x: 40, y: 200, width: 480, fontSize: 34, color: "#ffe066" }),
    ].filter(Boolean);
    apPlay(blocks, tt("课堂提问", "Question"));
    toast(tt("AI 已解答（右侧，新问题会覆盖前一问）", "AI answered (right panel; a new question replaces the previous)"), "ok");
  } catch (err) {
    toast(err.message.includes("Failed to fetch") ? tt("无法连接本地服务", "Cannot reach the local server") : err.message, "err");
  } finally {
    thinking(false);
  }
}

// ---------- AI 交互 ----------

function thinking(on, text) {
  const el = $("#thinking");
  el.classList.toggle("hidden", !on);
  if (on) $("#thinking-text").textContent = text || tt("AI 正在思考…", "AI is thinking…");
  for (const id of ["btn-generate"]) {
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
// ---------- 图片素材（拍照/选图，随文本一起发给视觉模型） ----------

let pendingImage = null; // dataURL（已压缩）；null = 无图片

function setImage(dataUrl) {
  pendingImage = dataUrl;
  $("#img-thumb").src = dataUrl;
  $("#img-preview").classList.toggle("hidden", !dataUrl);
}

async function fileToShrunkDataURL(file) {
  if (!file.type.startsWith("image/")) throw new Error("请选择图片文件");
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((ok, no) => {
      const im = new Image();
      im.onload = () => ok(im);
      im.onerror = () => no(new Error("图片读取失败"));
      im.src = url;
    });
    const MAX = 1600; // 最长边上限：够识别，控请求体大小
    const s = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(img.naturalWidth * s));
    c.height = Math.max(1, Math.round(img.naturalHeight * s));
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}

$("#btn-image").addEventListener("click", () => $("#board-image").click());
$("#board-image").addEventListener("change", async (e) => {
  const f = e.target.files && e.target.files[0];
  e.target.value = ""; // 允许重复选同一张
  if (!f) return;
  try {
    setImage(await fileToShrunkDataURL(f));
    toast("图片已就绪，点「开始学习」一起生成", "ok");
  } catch (err) {
    toast(err.message, "err");
  }
});
$("#btn-img-remove").addEventListener("click", () => setImage(null));


async function generateBoard() {
  const text = $("#text-input").value.trim();
  if (!text && !pendingImage) return toast(tt("先粘贴文本或拍张照片", "Paste text or upload a photo first"), "err");
  thinking(true, tt("老师正在备课…", "Teacher is preparing the lesson…"));
  try {
    const res = await fetch("api/text2board", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        ...(pendingImage ? { images: [pendingImage] } : {}),
        ...(lang === "en" ? { lang: "en" } : {}),
        canvasW: W,
        canvasH: H,
      }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || `HTTP ${res.status}`);
    const newPages = (data.pages || [])
      .map(normalizePage)
      .filter((p) => p._drawOrder.length > 0 || p.titleBlock || p.blocks.length || p.summaryBlock);
    // 计算最终 _drawOrder
    await Promise.all(newPages.map(loadFigures)); // SVG 图示先解析成图像，排版需要宽高比
    for (const p of newPages) layoutPage(p);
    const withContent = newPages.filter((p) => p._drawOrder.length > 0);
    if (!withContent.length) throw new Error(tt("模型没有生成有效板书，请重试", "Model returned no valid board, please retry"));
    stopAnim();
    pages = withContent;
    strokesByPage = pages.map(() => []);
    curPage = 0;
    syncPageNav();
    redrawStrokes();
    pages[0].animated = true;
    playNarration(pages[0]); // 生成即开讲：边讲边写
    $("#drawer").classList.add("hidden");
    toast(pages.length > 1 ? tt(`板书已生成，共 ${pages.length} 页（←/→ 翻页）`, `Board generated — ${pages.length} pages (←/→)`) : tt("板书已生成", "Board generated"), "ok");
  } catch (err) {
    toast(err.message.includes("Failed to fetch") ? tt("无法连接本地服务", "Cannot reach the local server") : err.message, "err");
  } finally {
    thinking(false);
  }
}

// ---------- AI 解答侧栏（独立小黑板：粉笔渲染 + 配音 + 标记，不与板书混排） ----------

const apPanel = $("#answer-panel");
const apCanvas = $("#ap-canvas");
const apCtx = apCanvas.getContext("2d");
const AP_W = 560;
const AP_H = 1000;
let apAnim = null; // { blocks, entries, marks, dur, startTs, tNow, audios, timers }
let apSeq = 0;
let apRaf = 0;

function fitApCanvas() {
  if (apPanel.classList.contains("hidden")) return;
  const rect = apCanvas.getBoundingClientRect();
  if (rect.width < 10 || rect.height < 10) return;
  const dpr = window.devicePixelRatio || 1;
  apCanvas.width = Math.round(rect.width * dpr);
  apCanvas.height = Math.round(rect.height * dpr); // 此前漏设：canvas 默认高 150，垂直被压至 0.15 倍 → 文字压扁模糊
  apPaintStatic(apAnim ? Infinity : undefined);
}

function computeApLayout(b) {
  apCtx.font = fontString(b);
  const lines = b.text ? wrapText(apCtx, b.text, b.width) : [];
  layouts.set(b.uid, { lines, lineH: b.fontSize * 1.7 });
  b._chars = lines.reduce((n, l) => n + l.length, 0);
}

function apBlockHeight(b) {
  const lay = layouts.get(b.uid);
  const figH = b.svg && b._figure ? b.width * b._figure.aspect + (lay && lay.lines.length ? 10 : 0) : 0;
  return figH + (lay ? lay.lines.length * lay.lineH : 0);
}

// 面板排版：顶部“AI 解答”题头 → 图优先 → 逐块下排，高度自适应
function apLayoutBlocks(blocks, title) {
  const head = { uid: `ap${++uidSeq}`, kind: "header", text: title || "AI 解答", x: 40, y: 30, width: AP_W - 80, fontSize: 44, color: "#ffe066", emphasis: [] };
  computeApLayout(head);
  const out = [head];
  let cursor = 30 + layouts.get(head.uid).lineH + 18;
  const list = [...blocks.filter((b) => b.svg), ...blocks.filter((b) => !b.svg)];
  for (const b of list) {
    b.fontSize = clampNum(b.fontSize || 36, 26, 44);
    b.x = 40;
    const avail = AP_H - 24 - cursor;
    if (b.svg) {
      const aspect = b._figure ? b._figure.aspect : 0.75;
      let wFloorAP = 160;
      const fig = b._figure;
      if (fig && fig.minFont && fig.vbW) wFloorAP = Math.min(AP_W - 80, Math.ceil((22 * fig.vbW) / fig.minFont));
      for (let w = AP_W - 80; w >= wFloorAP; w -= 40) {
        b.width = w;
        computeApLayout(b);
        const lay = layouts.get(b.uid);
        if (w * aspect + (lay.lines.length ? 10 : 0) + lay.lines.length * lay.lineH <= avail) break;
      }
      b.width = Math.max(b.width, wFloorAP); // 有效字号 ≥ 22 下限优先于高度
    } else {
      b.width = AP_W - 80;
      for (let t = 0; t < 4; t++) {
        computeApLayout(b);
        if (cursor + apBlockHeight(b) <= AP_H - 20 || b.fontSize <= 24) break;
        b.fontSize = Math.max(24, Math.round(b.fontSize * 0.9));
      }
    }
    b.y = cursor;
    cursor += apBlockHeight(b) + 14;
  }
  out.push(...list);
  return out;
}

// t=Infinity 全显；undefined 仅刷底色
function apPaintStatic(t) {
  apCtx.setTransform(1, 0, 0, 1, 0, 0);
  paintBoard(apCtx, apCanvas.width, apCanvas.height, theme);
  if (t !== undefined && apAnim) apRender(t);
}

function apRender(t) {
  apCtx.setTransform(1, 0, 0, 1, 0, 0);
  paintBoard(apCtx, apCanvas.width, apCanvas.height, theme);
  apCtx.setTransform(apCanvas.width / AP_W, 0, 0, apCanvas.height / AP_H, 0, 0);
  apCtx.textBaseline = "alphabetic";

  const quota = new Map();
  const partials = new Map();
  const figSave = figAlphaMap;
  figAlphaMap = new Map();
  if (t !== Infinity) {
    for (const e of apAnim.entries) {
      if (e.kind === "figure") {
        figAlphaMap.set(e.b.uid, Math.max(0, Math.min(1, (t - e.t0) / e.cost)));
        continue;
      }
      if (!quota.has(e.b.uid)) quota.set(e.b.uid, 0);
      const done = t >= e.t0 + e.cost;
      if (done) quota.set(e.b.uid, quota.get(e.b.uid) + 1);
      else if (t >= e.t0) partials.set(e.b.uid, { gi: e.gi, alpha: Math.max(0.1, (t - e.t0) / e.cost) });
    }
  }
  for (const b of apAnim.blocks) {
    const allowed = quota.size ? (quota.get(b.uid) ?? Infinity) : Infinity;
    drawBlock(apCtx, b, allowed, partials.get(b.uid));
  }
  for (const mk of apAnim.marks || []) {
    const frac = t !== Infinity ? Math.min(1, Math.max(0, (t - mk.tAppear) / 340)) : 1;
    if (frac <= 0) continue;
    drawSayMark(apCtx, mk, frac);
  }
  figAlphaMap = figSave;
}

function stopApAnim(finish) {
  const a = apAnim;
  apSeq++;
  if (apRaf) cancelAnimationFrame(apRaf);
  apRaf = 0;
  if (a) {
    for (const tm of a.timers) clearTimeout(tm);
    for (const au of a.audios) {
      try {
        au.pause();
      } catch {
        /* ignore */
      }
    }
  }
  if (finish && a) {
    a.entries = [];
    apRender(Infinity); // 定格完整解答
  }
}

// 面板讲解：快写完一块 → 讲这块（say 标记随语音画圈/划线）→ 下一块
async function apPlay(blocks, title) {
  stopApAnim(false);
  const seq = apSeq;
  const voices = await Promise.all(blocks.map(fetchVoice));
  lectureReset(false); // 提问互斥：解答期间讲义区隐藏（还原听课时由 setAskMode 恢复）
  const laid = apLayoutBlocks(blocks, title);
  const voiceMap = new Map(blocks.map((b, i) => [b, voices[i]]));
  const entries = [];
  const marks = [];
  const audios = [];
  const timers = [];
  let t = 300;
  const per = 70;
  for (const b of laid) {
    const v = voiceMap.get(b) ?? { el: null, dur: 0.5 };
    const start = t + 150;
    const figDur = b.svg ? 500 : 0;
    const lay = layouts.get(b.uid);
    if (b.svg) entries.push({ kind: "figure", b, t0: start, cost: 500 });
    let gi = 0;
    for (let li = 0; li < lay.lines.length; li++) {
      for (let ci = 0; ci < lay.lines[li].length; ci++) {
        entries.push({ kind: "char", b, li, ci, gi, t0: start + figDur + gi * per, cost: per });
        gi++;
      }
    }
    const writeDur = figDur + Math.max(300, gi * per);
    const speakAt = start + writeDur + 200;
    if (v.el) {
      audios.push(v.el);
      timers.push(
        setTimeout(() => {
          if (seq !== apSeq) return;
          v.el.currentTime = 0;
          v.el.play().catch(() => {});
        }, speakAt),
      );
    }
    // say 标记 → 面板行内定位，随语音时刻圈/划
    const parsed = parseSay(b.say);
    const cleanLen = Math.max(1, parsed.clean.length);
    if (parsed.marks.length) {
      apCtx.font = fontString(b);
      const yOff = b.svg ? apBlockHeight(b) - (lay.lines.length ? lay.lines.length * lay.lineH : 0) : 0;
      for (const mk of parsed.marks) {
        for (let li = 0; li < lay.lines.length; li++) {
          const idx = lay.lines[li].indexOf(mk.text);
          if (idx < 0) continue;
          const x0 = b.x + apCtx.measureText(lay.lines[li].slice(0, idx)).width;
          const x1 = x0 + apCtx.measureText(mk.text).width;
          marks.push({
            type: mk.type,
            text: mk.text,
            tAppear: speakAt + (mk.start / cleanLen) * v.dur * 1000,
            span: { x0, x1, y: b.y + yOff + li * lay.lineH + b.fontSize * 0.9, fontSize: b.fontSize },
          });
          break;
        }
      }
    }
    pushLectureSay(b, speakAt, v.dur * 1000); // 解答口述逐句进讲义
    t = speakAt + v.dur * 1000 + 350;
  }
  apAnim = { blocks: laid, entries, marks, dur: t + 200, startTs: 0, tNow: 0, audios, timers };
  const frame = (ts) => {
    if (!apAnim) return;
    if (!apAnim.startTs) apAnim.startTs = ts;
    apAnim.tNow = ts - apAnim.startTs;
    apRender(apAnim.tNow);
    lectureTick(apAnim.tNow);
    if (apAnim.tNow < apAnim.dur) apRaf = requestAnimationFrame(frame);
    else {
      apRaf = 0;
      apAnim.entries = [];
      apRender(Infinity);
      lectureTick(Infinity);
    }
  };
  apRaf = requestAnimationFrame(frame);
}

$("#btn-answer-close").addEventListener("click", () => {
  stopApAnim(false);
  apPanel.classList.add("hidden");
});
$("#ap-board").addEventListener("pointerdown", () => stopApAnim(true)); // 点击跳过书写
new ResizeObserver(() => fitApCanvas()).observe($("#ap-board"));


$("#btn-generate").addEventListener("click", () => {
  unlockAudio(); // Safari：生成后自动开讲，须在点击手势内解锁
  generateBoard();
});
$("#btn-load-course").addEventListener("click", () => {
  unlockAudio(); // Safari：加载课程即自动开讲
  $("#course-file").click();
});

// 抽屉
$("#btn-layout").addEventListener("click", () => $("#drawer").classList.toggle("hidden"));
$("#btn-drawer-close").addEventListener("click", () => $("#drawer").classList.add("hidden"));
$("#btn-sample").addEventListener("click", () => {
  if (lang === "en") {
    $("#text-input").value = [
      "# Meeting Notes: LLM Agent Product Review",
      "",
      "Thanks everyone for joining today. We're here to discuss next quarter's roadmap for our LLM Agent product.",
      "Let me walk through the background first, then open the floor, and we'll wrap up with conclusions and action items.",
      "",
      "Context: DAU has held steady at around 50k, but retention is only 23%.",
      "User feedback clusters into three themes: the task pipeline is too long and opaque;",
      "retry cost after failure is high enough that users would rather do it themselves; and multi-turn context often gets lost.",
      "",
      "The proposal is to replace auto-execution with a plan-confirm-execute flow: show the plan first, run after approval.",
      "We'd also add a live per-step log panel. Engineering estimates 3 people for 6 weeks for streaming DAG orchestration.",
      "QA reminded us to gray-scale at 5% first and watch the core funnel for a week.",
      "",
      "Bottom line: direction approved. Ship an MVP to validate whether plan confirmation lifts retention.",
      "Detailed schedule by next Friday. Meeting adjourned!",
    ].join("\n");
    return;
  }
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

// 设置弹窗 Tab 切换
for (const tab of document.querySelectorAll(".mtab")) {
  tab.addEventListener("click", () => {
    for (const t of document.querySelectorAll(".mtab")) t.classList.toggle("active", t === tab);
    for (const p of document.querySelectorAll(".tab-pane")) p.classList.toggle("active", p.id === tab.dataset.tab);
  });
}

async function openSettings() {
  try {
    const res = await fetch("api/config");
    const cfg = await res.json();
    $("#cfg-baseUrl").value = cfg.baseUrl || "";
    $("#cfg-apiKey").value = cfg.apiKeyMasked || "";
    $("#cfg-textModel").value = cfg.textModel || "";
    $("#cfg-maxRPM").value = cfg.maxRPM || 10;
    $("#cfg-disableThinking").checked = cfg.disableThinking !== false;
    $("#cfg-ttsBaseUrl").value = cfg.ttsBaseUrl || "";
    $("#cfg-ttsApiKey").value = cfg.ttsApiKeyMasked || "";
    $("#cfg-ttsModel").value = cfg.ttsModel || "";
    buildSettingSelects();
    $("#cfg-voice").value = VOICE_LIST.some((v) => v.id === voiceId) ? voiceId : VOICE_LIST[0].id;
    $("#cfg-font").value = fontChoice;
    $("#cfg-grain").value = String(chalkGrain);
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
    maxRPM: Number($("#cfg-maxRPM").value) || 10,
    disableThinking: $("#cfg-disableThinking").checked,
    ttsBaseUrl: $("#cfg-ttsBaseUrl").value.trim(),
    ttsApiKey: $("#cfg-ttsApiKey").value.trim(),
    ttsModel: $("#cfg-ttsModel").value.trim(),
    ttsVoice: $("#cfg-voice").value, // 音色由下拉选择（持久化）
    font: $("#cfg-font").value,
    grain: Number($("#cfg-grain").value),
  };
  try {
    const res = await fetch("api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || `HTTP ${res.status}`);
    voiceId = $("#cfg-voice").value; // 立即生效（语音按音色缓存，重讲即用新音色）
    applyFont($("#cfg-font").value);
    applyGrain($("#cfg-grain").value);
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
fetch("api/config")
  .then((r) => r.json())
  .then((cfg) => {
    if (!cfg.hasKey) {
      toast(tt("尚未配置 API Key，点「设置」填写后即可使用 AI", "No API key yet — open Settings to enable AI"), "err");
    }
    if (cfg.lang === "en") {
      lang = "en";
      applyLangUI();
    }
    // 持久化的字体与音色：先按本机可用性选定字体（偏好不可用则就近降级），再应用
    applyFont(initFontChoice(cfg.font));
    if (cfg.grain !== undefined) applyGrain(cfg.grain);
    if (cfg.ttsVoice && VOICE_LIST.some((v) => v.id === cfg.ttsVoice)) voiceId = cfg.ttsVoice;
  })
  .catch(() => {});
