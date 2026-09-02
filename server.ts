#!/usr/bin/env bun
// 「黑板」原型 — 本地代理服务器
// 职责：静态托管 / LLM 转发（保护密钥）/ 简单限流 / 配置管理
// 运行：bun server.ts   （默认 http://127.0.0.1:8918）

import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(ROOT, "public");
const CONFIG_PATH = join(ROOT, "config.json");
const PORT = Number(process.env.PORT ?? 8918);

// ---------- 类型 ----------

interface Emphasis {
  text: string;
  color: string; // 重点词直接用彩色粉笔书写（行内换色，不圈选）
}

interface BoardElement {
  id: string;
  text: string;
  x: number;
  y: number;
  width: number;
  fontSize: number;
  color: string;
  emphasis?: Emphasis[];
  say?: string; // 口播讲稿：讲什么（text 是写什么），二者分离
}

interface Region {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  header?: string;
}

interface BoardJSON {
  title: BoardElement | null;
  regions: Region[];
  blocks: BoardElement[];
  summary: BoardElement | null;
}

interface AppConfig {
  baseUrl: string;
  apiKey: string;
  textModel: string;
  visionModel: string;
  maxRPM: number;
  disableThinking: boolean;
  ttsBaseUrl: string;
  ttsApiKey: string;
  ttsModel: string;
  ttsVoice: string;
  ttsSpeed: number;
}

type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

interface ChatMessage {
  role: "system" | "user";
  content: string | ContentPart[];
}

// ---------- 类型守卫（外部 JSON 一律 unknown 进、守卫出） ----------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isStr(v: unknown): v is string {
  return typeof v === "string";
}

// ---------- 配置 ----------

const DEFAULT_CONFIG: AppConfig = {
  baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
  apiKey: "",
  textModel: "glm-5.3",
  visionModel: "glm-5.3-flash",
  maxRPM: 10,
  disableThinking: true,
  ttsBaseUrl: "https://api.siliconflow.cn/v1",
  ttsApiKey: "",
  ttsModel: "FunAudioLLM/CosyVoice2-0.5B",
  ttsVoice: "FunAudioLLM/CosyVoice2-0.5B:alex",
  ttsSpeed: 1.0,
};

function loadConfig(): AppConfig {
  const cfg: AppConfig = { ...DEFAULT_CONFIG };
  if (!existsSync(CONFIG_PATH)) return cfg;
  try {
    const parsed: unknown = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    if (!isRecord(parsed)) return cfg;
    if (isStr(parsed.baseUrl) && parsed.baseUrl.trim()) cfg.baseUrl = parsed.baseUrl.trim();
    if (isStr(parsed.apiKey)) cfg.apiKey = parsed.apiKey.trim();
    if (isStr(parsed.textModel) && parsed.textModel.trim()) cfg.textModel = parsed.textModel.trim();
    if (isStr(parsed.visionModel) && parsed.visionModel.trim()) cfg.visionModel = parsed.visionModel.trim();
    if (typeof parsed.maxRPM === "number" && Number.isFinite(parsed.maxRPM) && parsed.maxRPM > 0) {
      cfg.maxRPM = Math.min(60, Math.floor(parsed.maxRPM));
    }
    if (typeof parsed.disableThinking === "boolean") cfg.disableThinking = parsed.disableThinking;
    if (isStr(parsed.ttsBaseUrl) && parsed.ttsBaseUrl.trim()) cfg.ttsBaseUrl = parsed.ttsBaseUrl.trim();
    if (isStr(parsed.ttsApiKey)) cfg.ttsApiKey = parsed.ttsApiKey.trim();
    if (isStr(parsed.ttsModel) && parsed.ttsModel.trim()) cfg.ttsModel = parsed.ttsModel.trim();
    if (isStr(parsed.ttsVoice) && parsed.ttsVoice.trim()) cfg.ttsVoice = parsed.ttsVoice.trim();
    if (typeof parsed.ttsSpeed === "number" && Number.isFinite(parsed.ttsSpeed) && parsed.ttsSpeed >= 0.5 && parsed.ttsSpeed <= 2) {
      cfg.ttsSpeed = parsed.ttsSpeed;
    }
    return cfg;
  } catch (err) {
    console.error("config.json 解析失败，使用默认配置:", err instanceof Error ? err.message : err);
    return cfg;
  }
}

// ---------- 限流（令牌桶，动态 IP 键 → Map） ----------

const buckets = new Map<string, { tokens: number; last: number }>();

function allowRequest(ip: string, rpm: number): boolean {
  const now = Date.now();
  const b = buckets.get(ip) ?? { tokens: rpm, last: now };
  // 按流逝时间补充令牌，上限 rpm
  b.tokens = Math.min(rpm, b.tokens + ((now - b.last) / 60_000) * rpm);
  b.last = now;
  if (b.tokens < 1) {
    buckets.set(ip, b);
    return false;
  }
  b.tokens -= 1;
  buckets.set(ip, b);
  return true;
}

// ---------- LLM 调用（OpenAI 兼容 chat/completions） ----------

async function callLLM(cfg: AppConfig, model: string, messages: ChatMessage[], maxTokens: number): Promise<string> {
  const url = cfg.baseUrl.replace(/\/+$/, "") + "/chat/completions";
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.4,
      max_tokens: maxTokens,
      // 思考型模型禁思考可大幅提速（不支持该参数的服务端会忽略）
      ...(cfg.disableThinking ? { thinking: { type: "disabled" } } : {}),
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const errText = (await res.text()).slice(0, 400);
    throw new Error(`LLM 服务返回 ${res.status}: ${errText}`);
  }
  const data: unknown = await res.json();
  if (!isRecord(data) || !Array.isArray(data.choices) || data.choices.length === 0) {
    throw new Error("LLM 响应缺少 choices");
  }
  const first = data.choices[0] as unknown;
  if (isRecord(first) && isRecord(first.message) && isStr(first.message.content)) {
    return first.message.content; // reasoning_content 思考链不取，只用正文
  }
  throw new Error("LLM 响应缺少 content");
}

// ---------- LLM 输出解析：剥围栏 → 首个平衡对象 → 容错 parse ----------

function extractJSON(text: string): unknown | null {
  const cleaned = text.replace(/```[a-zA-Z]*\n?/g, "").replace(/```/g, "");
  const start = cleaned.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (ch === "\\") {
      if (inStr) esc = true;
      continue;
    }
    if (ch === '"') {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        // 修掉尾逗号后解析
        const slice = cleaned.slice(start, i + 1).replace(/,\s*([}\]])/g, "$1");
        try {
          return JSON.parse(slice);
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

// ---------- 板书 JSON 规整：字段容错 + 坐标钳制，保证不溢出画布 ----------

function coerceElement(v: unknown, id: string, W: number, H: number): BoardElement | null {
  if (!isRecord(v) || !isStr(v.text) || !v.text.trim()) return null;
  // 同一换算在 4 个字段上复用，保持一致语义
  const num = (x: unknown, d: number): number => (typeof x === "number" && Number.isFinite(x) ? x : d);
  const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
  const fontSize = clamp(Math.round(num(v.fontSize, 45)), 24, 90);
  const x = clamp(Math.round(num(v.x, 60)), 16, W - 80);
  const width = clamp(Math.round(num(v.width, 560)), 160, W - x - 24);
  const y = clamp(Math.round(num(v.y, 100)), 24, H - 48);
  const color = isStr(v.color) && /^#[0-9a-fA-F]{3,8}$/.test(v.color) ? v.color : "#f0f0f0";
  const emphasis: Emphasis[] = [];
  if (Array.isArray(v.emphasis)) {
    for (const e of v.emphasis) {
      if (!isRecord(e) || !isStr(e.text) || !e.text.trim()) continue;
      emphasis.push({
        text: e.text.trim().slice(0, 20),
        color: isStr(e.color) && /^#[0-9a-fA-F]{3,8}$/.test(e.color) ? e.color : "#ffe066",
      });
    }
  }
  return {
    id: isStr(v.id) && v.id ? v.id : id,
    text: v.text.trim(),
    x,
    y,
    width,
    fontSize,
    color,
    ...(emphasis.length ? { emphasis: emphasis.slice(0, 8) } : {}),
    ...(isStr(v.region) && v.region.trim() ? { region: v.region.trim() } : {}),
    ...(isStr(v.say) && v.say.trim() ? { say: v.say.trim().slice(0, 400) } : {}), // 口播讲稿（与板书 text 分离）
  };
}

function coerceRegion(v: unknown, i: number, W: number, H: number): Region | null {
  if (!isRecord(v)) return null;
  const num = (x: unknown, d: number): number => (typeof x === "number" && Number.isFinite(x) ? x : d);
  const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
  const x = clamp(Math.round(num(v.x, 60)), 40, W - 240);
  const y = clamp(Math.round(num(v.y, 150)), 130, H - 220);
  const width = clamp(Math.round(num(v.width, 700)), 200, W - 40 - x);
  const height = clamp(Math.round(num(v.height, 680)), 120, H - 40 - y);
  const header = isStr(v.header) && v.header.trim() ? v.header.trim().slice(0, 24) : undefined;
  return { id: isStr(v.id) && v.id ? v.id : `r${i + 1}`, x, y, width, height, ...(header ? { header } : {}) };
}

function normalizeBoard(json: unknown, W: number, H: number): BoardJSON {
  const board: BoardJSON = { title: null, regions: [], blocks: [], summary: null };
  if (!isRecord(json)) return board;
  board.title = coerceElement(json.title, "title", W, H);
  board.summary = coerceElement(json.summary, "summary", W, H);
  if (Array.isArray(json.regions)) {
    board.regions = json.regions
      .map((r, i) => coerceRegion(r, i, W, H))
      .filter((r): r is Region => r !== null)
      .slice(0, 6);
  }
  if (Array.isArray(json.blocks)) {
    board.blocks = json.blocks
      .map((b, i) => coerceElement(b, `block${i + 1}`, W, H))
      .filter((b): b is BoardElement => b !== null);
  }
  // 块引用的区域不存在时挂在第一个区域（前端兜底）
  if (board.regions.length > 0) {
    const ids = new Set(board.regions.map((r) => r.id));
    for (const b of board.blocks) {
      if (b.region && !ids.has(b.region)) b.region = board.regions[0].id;
    }
  }
  return board;
}

// 兼容单板与多页两种返回：{pages:[...]} → 多页；旧扁平结构 → 单页
function normalizePages(json: unknown, W: number, H: number): BoardJSON[] {
  if (isRecord(json) && Array.isArray(json.pages)) {
    return json.pages.map((p) => normalizeBoard(p, W, H));
  }
  return [normalizeBoard(json, W, H)];
}
// ---------- Prompt（方案 §2.2：先分区 → 区域内写字，前端确定性排版） ----------

function layoutSystemPrompt(W: number, H: number): string {
  return [
    "你是专业的黑板板书排版引擎兼授课教师。任务：把输入文本（冗长文章、笔记或 Markdown）精炼为「多页、分区、大字、重点分明」的黑板板书，同时为每块内容写口播讲稿。",
    "",
    "输出协议（严格只返回 JSON，无解释、无 markdown 代码块）：",
    '{"pages":[{',
    '  "title": {"text":"页标题","fontSize":72,"say":"这一页的开场口播，1~2 句，20~40 字"},',
    '  "regions": [',
    '    {"id":"r1","x":60,"y":170,"width":700,"height":660,"header":"栏目标题"},',
    '    {"id":"r2","x":840,"y":170,"width":700,"height":660,"header":"栏目标题"}',
    "  ],",
    '  "blocks": [',
    '    {"region":"r1","text":"写在黑板上的精简板书","fontSize":45,"color":"#f2f0e6","say":"老师口播讲解这一块，自然口语，40~70 字，可展开细节、举例、强调","emphasis":[{"text":"关键词","color":"#ffab6e"}]}',
    "  ],",
    '  "summary": {"text":"本页核心结论（一句话）","fontSize":48,"color":"#ffe066","say":"总结口播，20~40 字，收束本页"}',
    "}]}",
    "",
    "讲稿规则（say 与 text 分离，讲什么≠写什么）：",
    "- text = 板书：极简短语、关键词、数据，学生抄笔记用的。",
    "- say = 口播：自然口语的讲解，像老师边写边讲；讲稿内容覆盖该块要点，可口语化扩展、举例、强调；不必与 text 一致。",
    "- 讲稿嵌「板书动作标记」配合讲解：circle{词} = 讲到该词时在黑板上圈出它；underline{词} = 划下划线。标记在转语音时会被剥离，不会读出。",
    "- 标记完备性（硬性要求）：讲稿里每个要点/关键词讲到时都必须带标记——讲三个重点就画三个标记，一个都不能漏；每块讲稿 2~5 个标记。",
    "- 同等强度原则：同一重要级别的信息用同一种标记（最重要的关键词都用 circle，次级要点都用 underline），不许级别相同却标记不同或有的标有的不标。词必须与该块板书 text 原文完全一致。",
    "- 示例：\"say\":\"先记住 circle{Query} 和 circle{Key} 这两个输入，然后 underline{打分} 得到权重。\"",
    "",
    "排版规则：",
    "1. 先分区再写字（核心）：每页先把画布划分为 1~4 个矩形区域——常用左右两栏 / 上下两栏 / 2×2。区域之间留 40~70px 间隙（前端会在间隙画粉笔分隔线）。区域不重叠：x+width ≤ 1540，y+height ≤ 860，页面底部约 100px 留给总结条。",
    "2. 每个区域一个主题：header ≤ 10 字（黄色区头，自动带下划线）；区域内 2~4 块、每块 1~3 行。内容多就分更多页（1~4 页），每页一个主题，宁可翻页不要拥挤。",
    "3. 字要大（黑板精髓，远看要清楚）：页标题 66~80；区头 45（前端固定）；正文 42~54；总结 45~54。每块 text 控制在 1~2 行（字大行少）。",
    "4. 颜色是主要重点手段（8 色粉笔，必须丰富用色，每页至少出现 4~5 种颜色）：",
    "   白 #f2f0e6 正文 ｜ 灰 #d8d8d8 次要说明",
    "   黄 #ffe066 重点/结论/区头 ｜ 橙 #ffab6e 警示/注意/风险",
    "   粉 #ff9ec4 易错/记忆点 ｜ 蓝 #9fd8ff 数据/公式/数字",
    "   绿 #b8f2b8 好处/收益/正向 ｜ 紫 #d8b8ff 例子/引申/注释",
    "   整块换色 + 行内重点词换色搭配使用；summary 必须黄或粉。",
    "5. emphasis 彩色重点词：每页 4~8 个关键词直接指定彩色（比整块更跳脱的颜色）；关键词 ≤ 8 字且必须与所在块 text 原文完全一致。不使用圈选/下划线，纯靠颜色区分。",
    "6. 提纯：删客套话、铺垫、重复；保留论点、数据、结论。板书元素可用 ①②③、→、[图]。",
    "7. blocks 只需 region + text + say + fontSize + color + emphasis，不需要 x/y（前端在区域内自动排版）。",
    `画布每页 ${W}x${H} 像素（左上原点）。text 内用 \\n 换行。`,
  ].join("\n");
}

function visionPrompt(W: number, H: number, note: string): string {
  return [
    "你现在是黑板AI助教。用户提供一张黑板整屏截图。",
    `画布为 ${W}x${H} 像素坐标（左上角为原点）。`,
    "请：",
    "1. 识别图上所有印刷文字、手写文字、圈选、问号、草图与标记；",
    "2. 理解用户的提问、疑惑、解题或补充需求；",
    "3. 在黑板的空白区域作答：精准、简洁、分步、要点化，符合板书风格（可用 ①②③ 与 →）；",
    "4. 新内容必须放在空白处，避开图上已有内容所在区域，字号 36~48（大字），总量控制在 2~6 行；",
    "5. 颜色 8 色粉笔（丰富用色）：白 #f2f0e6 正文；黄 #ffe066 答案/重点；橙 #ffab6e 注意；粉 #ff9ec4 纠错/易错；蓝 #9fd8ff 公式/推导；绿 #b8f2b8 验证/正确；灰 #d8d8d8 次要；紫 #d8b8ff 注释。",
    '6. emphasis 彩色重点词（与 text 原文完全一致，≤8 字）：[{"text":"答案","color":"#ffe066"}]',
    '8. say 里可嵌板书动作标记：circle{词}/underline{词}（词必须是本块 text 原文，讲到时圈/划它；转语音会剥离标记）。例："say":"先算 circle{乘积}，再 underline{求和}。"',
    "严格只返回板书 JSON（无解释、无 markdown 代码块）：",
    '{"blocks":[{"id":"a1","text":"…","x":0,"y":0,"width":640,"fontSize":42,"color":"#f2f0e6","say":"口播讲解…","emphasis":[{"text":"…","color":"#ffe066"}]}]}',
    note ? `用户附加说明：${note}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

// ---------- HTTP ----------

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function jsonError(message: string, status: number): Response {
  return Response.json({ ok: false, error: message }, { status });
}

async function readJSONBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await req.json();
    return isRecord(body) ? body : null;
  } catch {
    return null;
  }
}

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";

    try {
      if (path === "/api/health") return Response.json({ ok: true });

      // ---- 配置：读（密钥打码）/ 写 ----
      if (path === "/api/config" && req.method === "GET") {
        const cfg = loadConfig();
        return Response.json({
          ok: true,
          baseUrl: cfg.baseUrl,
          textModel: cfg.textModel,
          visionModel: cfg.visionModel,
          maxRPM: cfg.maxRPM,
          disableThinking: cfg.disableThinking,
          ttsBaseUrl: cfg.ttsBaseUrl,
          ttsModel: cfg.ttsModel,
          ttsVoice: cfg.ttsVoice,
          ttsSpeed: cfg.ttsSpeed,
          hasTtsKey: cfg.ttsApiKey.length > 0,
          ttsApiKeyMasked: cfg.ttsApiKey ? `${cfg.ttsApiKey.slice(0, 10)}…${cfg.ttsApiKey.slice(-4)}` : "",
          hasKey: cfg.apiKey.length > 0,
        });
      }

      if (path === "/api/config" && req.method === "POST") {
        const body = await readJSONBody(req);
        if (!body) return jsonError("请求体必须是 JSON 对象", 400);
        const cfg = loadConfig();
        if (isStr(body.baseUrl) && body.baseUrl.trim()) cfg.baseUrl = body.baseUrl.trim();
        // 打码值原样传回时不覆盖真实密钥
        if (isStr(body.apiKey) && body.apiKey.trim() && !body.apiKey.includes("…")) {
          cfg.apiKey = body.apiKey.trim();
        }
        if (isStr(body.textModel) && body.textModel.trim()) cfg.textModel = body.textModel.trim();
        if (isStr(body.visionModel) && body.visionModel.trim()) cfg.visionModel = body.visionModel.trim();
        if (typeof body.maxRPM === "number" && Number.isFinite(body.maxRPM) && body.maxRPM > 0) {
          cfg.maxRPM = Math.min(60, Math.floor(body.maxRPM));
        }
        if (typeof body.disableThinking === "boolean") cfg.disableThinking = body.disableThinking;
        if (isStr(body.ttsBaseUrl) && body.ttsBaseUrl.trim()) cfg.ttsBaseUrl = body.ttsBaseUrl.trim();
        if (isStr(body.ttsApiKey) && body.ttsApiKey.trim() && !body.ttsApiKey.includes("…")) {
          cfg.ttsApiKey = body.ttsApiKey.trim();
        }
        if (isStr(body.ttsModel) && body.ttsModel.trim()) cfg.ttsModel = body.ttsModel.trim();
        if (isStr(body.ttsVoice) && body.ttsVoice.trim()) cfg.ttsVoice = body.ttsVoice.trim();
        if (typeof body.ttsSpeed === "number" && Number.isFinite(body.ttsSpeed) && body.ttsSpeed >= 0.5 && body.ttsSpeed <= 2) {
          cfg.ttsSpeed = body.ttsSpeed;
        }
        writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
        try {
          chmodSync(CONFIG_PATH, 0o600); // 双保险：已有文件也收敛权限
        } catch {
          /* chmod 失败不影响运行 */
        }
        return Response.json({ ok: true });
      }

      // ---- 文本 → 板书 ----
      if (path === "/api/text2board" && req.method === "POST") {
        const body = await readJSONBody(req);
        if (!body) return jsonError("请求体必须是 JSON 对象", 400);
        if (!isStr(body.text) || !body.text.trim()) return jsonError("text 不能为空", 400);
        if (body.text.length > 20_000) return jsonError("text 过长（上限 2 万字符）", 400);
        const W = typeof body.canvasW === "number" ? body.canvasW : 1600;
        const H = typeof body.canvasH === "number" ? body.canvasH : 1000;

        const cfg = loadConfig();
        if (!cfg.apiKey) return jsonError("未配置 API Key，请先在「设置」中填写", 400);
        if (!allowRequest(ip, cfg.maxRPM)) return jsonError(`请求过于频繁，限流 ${cfg.maxRPM} 次/分钟`, 429);

        const content = await callLLM(
          cfg,
          cfg.textModel,
          [
            { role: "system", content: layoutSystemPrompt(W, H) },
            { role: "user", content: body.text },
          ],
          8192,
        );
        const pages = normalizePages(extractJSON(content), W, H).filter(
          (p) => p.title !== null || p.blocks.length > 0 || p.summary !== null,
        );
        if (pages.length === 0) {
          return jsonError("模型未返回有效板书 JSON，请重试", 502);
        }
        return Response.json({ ok: true, pages, raw: content.length > 2000 ? content.slice(0, 2000) : content });
      }

      // ---- 整屏截图 → 多模态识图作答 ----
      if (path === "/api/answer" && req.method === "POST") {
        const body = await readJSONBody(req);
        if (!body) return jsonError("请求体必须是 JSON 对象", 400);
        if (!isStr(body.image) || !body.image.startsWith("data:image/")) {
          return jsonError("image 必须是 data:image/* 的 Base64 DataURL", 400);
        }
        const W = typeof body.canvasW === "number" ? body.canvasW : 1600;
        const H = typeof body.canvasH === "number" ? body.canvasH : 1000;
        const note = isStr(body.note) ? body.note.slice(0, 500) : "";

        const cfg = loadConfig();
        if (!cfg.apiKey) return jsonError("未配置 API Key，请先在「设置」中填写", 400);
        if (!allowRequest(ip, cfg.maxRPM)) return jsonError(`请求过于频繁，限流 ${cfg.maxRPM} 次/分钟`, 429);

        const content = await callLLM(
          cfg,
          cfg.visionModel,
          [
            {
              role: "user",
              content: [
                { type: "text", text: visionPrompt(W, H, note) },
                { type: "image_url", image_url: { url: body.image } },
              ],
            },
          ],
          8192,
        );
        const board = normalizeBoard(extractJSON(content), W, H);
        if (board.blocks.length === 0 && !board.title && !board.summary) {
          return jsonError("模型未返回有效作答 JSON，请重试", 502);
        }
        return Response.json({ ok: true, board, raw: content.length > 2000 ? content.slice(0, 2000) : content });
      }

      // ---- 指句提问：学生指着黑板某行文字，AI 给出就地解释 ----
      if (path === "/api/ask" && req.method === "POST") {
        const body = await readJSONBody(req);
        if (!body) return jsonError("请求体必须是 JSON 对象", 400);
        if (!isStr(body.line) || !body.line.trim()) return jsonError("line 不能为空", 400);
        const line = body.line.slice(0, 300);
        const context = isStr(body.context) ? body.context.slice(0, 2000) : "";
        const px = typeof body.x === "number" ? Math.round(body.x) : 0;
        const py = typeof body.y === "number" ? Math.round(body.y) : 0;
        const W = typeof body.canvasW === "number" ? body.canvasW : 1600;
        const H = typeof body.canvasH === "number" ? body.canvasH : 1000;

        const cfg = loadConfig();
        if (!cfg.apiKey) return jsonError("未配置 API Key，请先在「设置」中填写", 400);
        if (!allowRequest(ip, cfg.maxRPM)) return jsonError(`请求过于频繁，限流 ${cfg.maxRPM} 次/分钟`, 429);

        const content = await callLLM(
          cfg,
          cfg.textModel,
          [
            {
              role: "system",
              content: [
                "你是黑板AI助教。学生用教鞭指着黑板上的一行字提问，你要就地给出解释。",
                `整块黑板的板书内容（上下文）：\n${context || "（空）"}`,
                `学生指的位置：(${px}, ${py})，画布 ${W}x${H}。`,
                `学生指的这行字：「${line}」`,
                "要求：结合上下文解释这行字在讲什么；口语化、直接回答；25~60 字；不要复述问题，不要客套。",
                '严格只返回 JSON（无解释无代码块）：{"text":"解释内容"}',
              ].join("\n"),
            },
            { role: "user", content: `这行是什么意思？「${line}」` },
          ],
          1024,
        );
        const parsed = extractJSON(content);
        const text = isRecord(parsed) && isStr(parsed.text) && parsed.text.trim() ? parsed.text.trim().slice(0, 120) : "";
        if (!text) return jsonError("模型未返回有效解释，请重试", 502);
        return Response.json({ ok: true, text });
      }

      // ---- 讲稿配音（SiliconFlow 兼容 /audio/speech） ----
      if (path === "/api/tts" && req.method === "POST") {
        const body = await readJSONBody(req);
        if (!body) return jsonError("请求体必须是 JSON 对象", 400);
        if (!isStr(body.text) || !body.text.trim()) return jsonError("text 不能为空", 400);
        const text = body.text.slice(0, 500);
        const cfg = loadConfig();
        // 音色可由前端覆盖（教师切换：男/女声）；格式非法则回退配置值
        const voice = isStr(body.voice) && /^[\w.-]+\/[\w.-]+:[\w.-]+$/.test(body.voice.trim()) ? body.voice.trim() : cfg.ttsVoice;



        const ttsRes = await fetch(cfg.ttsBaseUrl.replace(/\/+$/, "") + "/audio/speech", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${cfg.ttsApiKey}`,
          },
          body: JSON.stringify({
            model: cfg.ttsModel,
            input: text,
            voice,
            response_format: "mp3",
            speed: cfg.ttsSpeed,
          }),
          signal: AbortSignal.timeout(60_000),
        });
        if (!ttsRes.ok) {
          const errText = (await ttsRes.text()).slice(0, 300);
          throw new Error(`TTS 服务返回 ${ttsRes.status}: ${errText}`);
        }
        const bytes = new Uint8Array(await ttsRes.arrayBuffer());
        let bin = "";
        for (let i = 0; i < bytes.length; i += 0x8000) {
          bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); // 32k 分块，避免 spread 参数上限
        }
        return Response.json({ ok: true, audio: `data:audio/mpeg;base64,${btoa(bin)}` });
      }

      // ---- 静态文件 ----
      const rel = path === "/" ? "/index.html" : path;
      const file = join(PUBLIC_DIR, rel);
      if (!file.startsWith(PUBLIC_DIR)) return new Response("Forbidden", { status: 403 });
      const f = Bun.file(file);
      if (await f.exists()) {
        return new Response(f, { headers: { "Content-Type": MIME[extname(file)] ?? "application/octet-stream" } });
      }
      return new Response("Not Found", { status: 404 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[ERR] ${req.method} ${path}:`, msg);
      return jsonError(msg.slice(0, 500), 500);
    }
  },
});

console.log(`黑板原型已启动: http://127.0.0.1:${PORT}`);
