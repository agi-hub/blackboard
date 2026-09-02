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
  style: "circle" | "underline";
  color: string;
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
}

interface BoardJSON {
  title: BoardElement | null;
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
  const fontSize = clamp(Math.round(num(v.fontSize, 20)), 14, 60);
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
        style: e.style === "circle" ? "circle" : "underline",
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
  };
}

function normalizeBoard(json: unknown, W: number, H: number): BoardJSON {
  const board: BoardJSON = { title: null, blocks: [], summary: null };
  if (!isRecord(json)) return board;
  board.title = coerceElement(json.title, "title", W, H);
  board.summary = coerceElement(json.summary, "summary", W, H);
  if (Array.isArray(json.blocks)) {
    board.blocks = json.blocks
      .map((b, i) => coerceElement(b, `block${i + 1}`, W, H))
      .filter((b): b is BoardElement => b !== null);
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
// ---------- Prompt（依据 MVP 方案 §2.2 / §2.3，多页 + 重点标记版） ----------

function layoutSystemPrompt(W: number, H: number): string {
  return [
    "你是专业的黑板板书排版引擎。任务：把输入文本（冗长文章、笔记或 Markdown）精炼后，排版为「多页黑板板书」。",
    "分页规则：",
    "1. 内容多时拆分为多页（通常 1~4 页），每页只讲一个主题：顶部标题 + 2~3 个内容块 + 可选总结；宁可多翻页，也不许拥挤。内容少则单页。",
    "2. 字号要大（核心要求）：标题 40~52；正文 26~32；补充说明 22~26；总结 26~32。每块 text 不超过 4 行。",
    "3. 布局：每页均为顶部标题、正文左右分栏或上下排布、底部总结；块之间不重叠。",
    "4. 颜色（粉笔色板，重点要突出）：",
    "   - 普通正文 #f2f0e6（白）/ #d8d8d8（灰）",
    "   - 重点句/结论块 #ffe066（黄）；警示/易错 #ff9ec4（粉）；数据/公式 #9fd8ff（蓝）；好处/收益 #b8f2b8（绿）",
    "   - 标题 #ffe066；总结 #ffe066 或 #ff9ec4",
    "5. 重点标记 emphasis：每页挑 2~5 个关键词，用圈选或下划线标注（关键词 ≤ 8 字，必须与所在块 text 中的原文完全一致）：",
    '   [{"text":"关键词","style":"circle"|"underline","color":"#ffe066"}]',
    `6. 画布每页 ${W}x${H} 像素坐标（左上原点）。左右边距 ≥ 80，底部预留 ≥ 80，x+width ≤ ${W - 60}，y+行数*fontSize*1.7 < ${H - 60}。`,
    "7. 板书元素可用：①②③ 分点、→ 推导、[图] 占位、—— 强调。",
    "严格只返回如下 JSON（无解释、无 markdown 代码块）：",
    '{"pages":[{"title":{"text":"…","x":0,"y":0,"fontSize":46,"color":"#ffe066"},"blocks":[{"id":"b1","text":"…","x":0,"y":0,"width":640,"fontSize":28,"color":"#f2f0e6","emphasis":[{"text":"…","style":"circle","color":"#ff9ec4"}]}],"summary":{"text":"…","x":0,"y":0,"fontSize":28,"color":"#ffe066"}}]}',
    "summary 可为 null；text 内用 \\n 表示换行。",
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
    "4. 新内容必须放在空白处，避开图上已有内容所在区域，字号 24~32（大字），总量控制在 4~10 行；",
    "5. 颜色粉笔色板：答案/重点 #ffe066（黄）；警示/纠错 #ff9ec4（粉）；公式/推导 #9fd8ff（蓝）；正文 #f2f0e6（白）。",
    "6. 用 emphasis 标注答案关键词（与 text 原文完全一致，≤8 字）：[{\"text\":\"答案\",\"style\":\"circle\",\"color\":\"#ffe066\"}]",
    "严格只返回板书 JSON（无解释、无 markdown 代码块）：",
    '{"blocks":[{"id":"a1","text":"…","x":0,"y":0,"width":640,"fontSize":28,"color":"#f2f0e6","emphasis":[{"text":"…","style":"circle","color":"#ffe066"}]}]}',
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
          hasKey: cfg.apiKey.length > 0,
          apiKeyMasked: cfg.apiKey ? `${cfg.apiKey.slice(0, 8)}…${cfg.apiKey.slice(-4)}` : "",
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
