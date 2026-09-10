#!/usr/bin/env bun
// 「黑板」原型 — 本地代理服务器
// 职责：静态托管 / LLM 转发（保护密钥）/ 简单限流 / 配置管理
// 运行：bun server.ts   （默认 http://127.0.0.1:8918）

import { existsSync, readFileSync, writeFileSync, chmodSync, appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
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
  svg?: string; // 行内 SVG 图示（粉笔线框风，前端解析绘制）
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
  visionModel: string; // 视觉模型（图片素材识别，纯文本时不用）
  maxRPM: number;
  disableThinking: boolean;
  ttsBaseUrl: string;
  ttsApiKey: string;
  ttsModel: string;
  ttsVoice: string;
  ttsSpeed: number;
  font: string; // 板书字体预设 id（前端可选）
  uiFont: string; // 界面字体预设 id（按钮/标题；前端可选）
  posterModel: string; // 板报文生图模型（SiliconFlow /images/generations）
  grain: number; // 字体磨砂强度 0~2.5
  theme: "black" | "green"; // 板书主题（黑板/绿板）
  lang: "zh" | "en"; // 界面与生成内容语言
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
  font: "kaiti",
  uiFont: "default",
  posterModel: "Tongyi-MAI/Z-Image-Turbo",
  grain: 1.3,
  theme: "green",
  lang: "zh",
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
    if (isStr(parsed.font) && parsed.font.trim()) cfg.font = parsed.font.trim().slice(0, 32);
    if (isStr(parsed.uiFont) && parsed.uiFont.trim()) cfg.uiFont = parsed.uiFont.trim().slice(0, 32);
    if (isStr(parsed.posterModel) && parsed.posterModel.trim()) cfg.posterModel = parsed.posterModel.trim().slice(0, 64);
    if (parsed.theme === "black" || parsed.theme === "green") cfg.theme = parsed.theme;
    if (typeof parsed.grain === "number" && Number.isFinite(parsed.grain) && parsed.grain >= 0 && parsed.grain <= 2.5) cfg.grain = parsed.grain;
    if (parsed.lang === "en" || parsed.lang === "zh") cfg.lang = parsed.lang;
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

// ---------- 生成日志（JSONL 落盘 + 内存尾部环形缓冲） ----------
interface GenLog {
  ts: string; // ISO 时间
  type: "text2board" | "ask" | "tts" | "asr" | "clog" | "poster";
  durationMs: number; // 耗时
  ip: string;
  model?: string; // LLM/TTS/ASR 模型
  lang?: string;
  stream?: boolean;
  pages?: number; // text2board 产出页数
  blocks?: number; // 总块数
  material?: string; // 素材摘要（截断）
  images?: number; // 附带图片数
  error?: string; // 失败原因
}

const LOG_PATH = join(ROOT, "logs", "gen.jsonl");
const LOG_TAIL_MAX = 500; // 内存环形缓冲条数（/api/logs 快速读取）
const logTail: GenLog[] = [];
let logSize = 0; // 当日文件字节数（超限轮转）

function appendLog(entry: Omit<GenLog, "ts">): void {
  const full: GenLog = { ts: new Date().toISOString(), ...entry };
  const line = JSON.stringify(full) + "\n";
  try {
    // 目录懒创建；单文件 >10MB 轮转为 .1（保留上一份，够用且零依赖）
    if (logSize > 10_000_000) {
      renameSync(LOG_PATH + ".1", LOG_PATH + ".2");
      renameSync(LOG_PATH, LOG_PATH + ".1");
      logSize = 0;
    }
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    appendFileSync(LOG_PATH, line);
    logSize += line.length;
  } catch (err) {
    console.error("日志写入失败:", err instanceof Error ? err.message : err);
  }
  logTail.push(full);
  if (logTail.length > LOG_TAIL_MAX) logTail.shift();
  // 控制台同步一行可读摘要（systemd journal 亦留痕）
  const info = full.type === "text2board"
    ? `素材「${full.material ?? ""}」${full.images ? `+${full.images}图 ` : ""}→ ${full.pages ?? 0} 页/${full.blocks ?? 0} 块`
    : full.type === "ask"
      ? `指句「${full.material ?? ""}」`
      : full.type;
  console.log(`[LOG] ${full.ts} ${full.ok ? "OK " : "ERR"} ${full.type} ${full.durationMs}ms ${info}${full.error ? ` | ${full.error}` : ""}`);
}

// 素材摘要：压空白、去首尾，截 60 字符
function summarizeMaterial(text: unknown): string {
  if (!isStr(text)) return "";
  return text.replace(/\s+/g, " ").trim().slice(0, 60);
}
try {
  logSize = statSync(LOG_PATH).size; // 重启后续写：先读现有文件大小，轮转判断才准
} catch {
  logSize = 0;
}


// ---------- PNG 黑底转透明（板报用）：零依赖解码→逐像素→重编码 ----------
// 纯黑（含容差）像素 alpha=0；粉笔线条按亮度保留。只支持非隔行 8bit RGB/RGBA
// （Kolors 输出实测 RGBA）；其余格式抛错由调用方兜底返回原图。
function blackToAlphaPng(bytes: Uint8Array): Uint8Array {
  const zlib = require("node:zlib");
  const CRC_TABLE = new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (buf: Uint8Array, start: number, end: number) => {
    let c = 0xffffffff;
    for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const readU32 = (b: Uint8Array, o: number) => (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3];
  let pos = 8; // PNG 签名
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat: Uint8Array[] = [];
  while (pos + 8 <= bytes.length) {
    const len = readU32(bytes, pos);
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    const data = bytes.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = readU32(data, 0); height = readU32(data, 4);
      bitDepth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  if (!width || !height) throw new Error("PNG 尺寸解析失败");
  if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2)) throw new Error(`不支持的 PNG depth=${bitDepth} color=${colorType}`);
  if (interlace !== 0) throw new Error("隔行 PNG 不支持");
  const bpp = colorType === 6 ? 4 : 3;
  // 解压 + 去滤波（PNG filter 0-4）
  const raw = new Uint8Array(zlib.inflateSync(Buffer.concat(idat.map((c) => Buffer.from(c)))));
  const stride = width * bpp;
  const px = new Uint8Array((stride + 1) * height); // 去滤波后按行存储（无 filter 字节）
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[y * stride + x - bpp] : 0;
      const b = y > 0 ? px[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? px[(y - 1) * stride + x - bpp] : 0;
      let v = raw[src + x];
      if (f === 1) v = (v + a) & 0xff;
      else if (f === 2) v = (v + b) & 0xff;
      else if (f === 3) v = (v + ((a + b) >> 1)) & 0xff;
      else if (f === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
      }
      px[y * stride + x] = v;
    }
  }
  // 黑→透明：背景基准 = 全图亮度直方图众数（背景占多数像素，众数即背景主色）；
  // 边缘采样在"晕影图"（边缘比中心暗）上失真。众数必为暗色才可信（亮众数=内容铺满→守卫拦截）
  const lumBins = new Map<number, number>(); // bin=8 灰度桶 → 计数
  for (let i = 0; i < px.length; i += bpp) {
    const lum = (px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000;
    const bin = Math.round(lum / 8) * 8;
    lumBins.set(bin, (lumBins.get(bin) ?? 0) + 1);
  }
  let bgLum = 0, bgCount = 0;
  for (const [bin, n] of lumBins) {
    if (n > bgCount) { bgCount = n; bgLum = bin; }
  }
  // 背景饱和度：亮度在众数 ±20 内的像素平均饱和度
  const bgSat = (() => {
    let sum = 0, n = 0;
    for (let i = 0; i < px.length; i += bpp) {
      const r = px[i], g = px[i + 1], b = px[i + 2];
      const lum = (r * 299 + g * 587 + b * 114) / 1000;
      if (Math.abs(lum - bgLum) < 20) { sum += Math.max(r, g, b) - Math.min(r, g, b); n++; }
    }
    return n ? sum / n : 0;
  })();
  // 守卫：众数太亮（背景不是暗色 → 内容铺满）不转换，原图返回
  if (bgLum > 90 || bgCount / (width * height) < 0.12) throw new Error("背景不是暗色，跳过转透明");
  const isBg = (r: number, g: number, b: number) => {
    const lum = (r * 299 + g * 587 + b * 114) / 1000;
    const sat = Math.max(r, g, b) - Math.min(r, g, b);
    if (lum > bgLum + 55) return false; // 明显比背景亮 → 粉笔内容
    if (sat > bgSat + 50) return false; // 明显比背景鲜艳 → 彩色粉笔
    const dist = Math.abs(lum - bgLum) + Math.max(0, sat - bgSat);
    return dist < 42;
  };
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const si = y * stride + x * bpp, di = (y * width + x) * 4;
      const r = px[si], g = px[si + 1], b = px[si + 2];
      const lum = (r * 299 + g * 587 + b * 114) / 1000;
      const sat = Math.max(r, g, b) - Math.min(r, g, b);
      let alpha = 255;
      if (isBg(r, g, b)) {
        const dist = Math.abs(lum - bgLum) + Math.max(0, sat - bgSat);
        // dist<16 视为纯背景全透；16~42 平方衰减（陡峭，避免灰蒙蒙）
        alpha = dist < 16 ? 0 : Math.min(255, Math.round(((dist - 16) / 26) ** 1.6 * 255));
      } else if (lum < bgLum + 55 && lum < 60 && sat < 40) {
        alpha = Math.round(lum * 1.5); // 比背景更暗的纯黑残留也吃掉
      }
      rgba[di] = r; rgba[di + 1] = g; rgba[di + 2] = b;
      rgba[di + 3] = (alpha * (bpp === 4 ? px[si + 3] : 255)) / 255;
    }
  }
  // 重编码：filter 全 0 + deflate
  const outStride = width * 4;
  const rawOut = new Uint8Array((outStride + 1) * height);
  for (let y = 0; y < height; y++) {
    rawOut[y * (outStride + 1)] = 0;
    rawOut.set(rgba.subarray(y * outStride, (y + 1) * outStride), y * (outStride + 1) + 1);
  }
  const compressed = zlib.deflateSync(Buffer.from(rawOut), { level: 6 });
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    new DataView(out.buffer).setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    new DataView(out.buffer).setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
    return out;
  };
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, width);
  new DataView(ihdr.buffer).setUint32(4, height);
  ihdr[8] = 8; ihdr[9] = 6; // 8bit RGBA
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [sig, chunk("IHDR", ihdr), chunk("IDAT", new Uint8Array(compressed)), chunk("IEND", new Uint8Array(0))];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const outPng = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { outPng.set(p, o); o += p.length; }
  return outPng;
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

// 流式调用：LLM 逐块输出时回调 onChunk（用于 text2board 增量提取 pages，边生成边推页）
async function callLLMStream(
  cfg: AppConfig,
  model: string,
  messages: ChatMessage[],
  maxTokens: number,
  onChunk: (full: string) => void,
): Promise<string> {
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
      stream: true,
      ...(cfg.disableThinking ? { thinking: { type: "disabled" } } : {}),
    }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok || !res.body) {
    const errText = res.ok ? "" : (await res.text()).slice(0, 400);
    throw new Error(`LLM 服务返回 ${res.status}: ${errText}`);
  }
  let full = "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const payload = t.slice(5).trim();
      if (payload === "[DONE]") continue;
      try {
        const j: unknown = JSON.parse(payload);
        const delta = (j as { choices?: Array<{ delta?: { content?: string } }> }).choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta) {
          full += delta;
          onChunk(full);
        }
      } catch {
        /* 半包 JSON 忽略 */
      }
    }
  }
  return full;
}

// 增量提取 pages 数组中已完整（括号平衡）的页对象：[新页列表, 下次扫描起点]
function extractNewPages(text: string, fromIndex: number): [unknown[], number] {
  const pagesKey = text.indexOf('"pages"');
  if (pagesKey === -1) return [[], fromIndex];
  const arrIdx = text.indexOf("[", pagesKey);
  if (arrIdx === -1) return [[], fromIndex];
  const out: unknown[] = [];
  let cursor = fromIndex || arrIdx + 1;
  for (;;) {
    const objStart = text.indexOf("{", cursor);
    if (objStart === -1) break;
    let depth = 0;
    let inStr = false;
    let esc = false;
    let end = -1;
    for (let i = objStart; i < text.length; i++) {
      const ch = text[i];
      if (esc) { esc = false; continue; }
      if (ch === "\\") { if (inStr) esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end === -1) break; // 页对象尚未写完
    const slice = text.slice(objStart, end + 1).replace(/,\s*([}\]])/g, "$1");
    try {
      out.push(JSON.parse(slice));
    } catch {
      /* 坏页跳过 */
    }
    cursor = end + 1;
    const closeArr = text.indexOf("]", cursor);
    const nextObj = text.indexOf("{", cursor);
    if (closeArr !== -1 && (nextObj === -1 || closeArr < nextObj)) break; // pages 数组闭合
  }
  return [out, cursor];
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
    ...(sanitizeSvg(v.svg) ? { svg: sanitizeSvg(v.svg) as string } : {}),
  };
}

// SVG 安全闸：必须是 <svg>…</svg>、限长、禁脚本/事件/外链（重复调用方自行短路）
function sanitizeSvg(raw: unknown): string | null {
  const s = isStr(raw) ? raw.trim() : "";
  if (!s.startsWith("<svg") || !s.includes("</svg>") || s.length > 8000) return null;
  // 剥离合法的 xmlns 命名空间声明后再查外链（w3.org 命名空间是 SVG 必需的，不是外链）
  const noNs = s.replace(/xmlns(:\w+)?="http:\/\/www\.w3\.org\/[^"]*"/g, "").replace(/xmlns(:\w+)?='http:\/\/www\.w3\.org\/[^']*'/g, "");
  if (/<script|on\w+\s*=|javascript:|https?:\/\//i.test(noNs)) return null;
  return s;
}

// 两段式补图：主生成未产出 svg 时，专门再调一次画图
function figurePrompt(boardSummary: string, en = false): string {
  return [
    "你是黑板画图助手。为下面的黑板板书内容配 1~2 张讲解图（流程图/结构图/示意图），帮助理解。",
    "严格只返回 JSON 数组（无解释、无 markdown 代码块）：",
    '[{"svg":"<svg viewBox=\'0 0 400 300\' xmlns=\'http://www.w3.org/2000/svg\'>…</svg>","text":"图题（≤10字，直接写内容，禁止加【图】/(图)等前缀——板书没人这么写）","say":"配合图的一句讲解（20~40字）"}]',
    "SVG 硬性要求：粉笔线框风——stroke 用 #f2f0e6/#ffe066/#9fd8ff/#ff9ec4，stroke-width 3，fill='none'；所有图形元素（rect/circle/ellipse/path/polyline/polygon/line）都必须显式带 fill='none'，折线图/趋势线绝不填充底色；用矩形框 + 箭头(path/line) + 少量 <text>（font-size 20~24、text-anchor='middle'、fill 用粉笔色；图会被等比缩放，字号务必 ≥20 否则缩放后看不清）；viewBox='0 0 400 300'；元素 ≤ 30；严禁 script/事件属性/外链。",
    ...(en ? ["text 与 say 一律用英文（图题与讲解，不得出现中文）。"] : []),
    "板书内容：",
    boardSummary,
  ].join("\n");
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

// 图片素材附加提示：识别图中文字/题目，题目自动附解题过程
const IMAGE_HINT = [
  "",
  "素材里附有图片（拍照或截图）。要求：",
  "- 先仔细识别图片里的全部文字、公式、图形与题目条件，把识别结果当作输入素材的一部分来提炼板书。",
  "- 如果图片是一道题目（习题/例题/考题），必须专门辟区域完整呈现：题目条件 → 解题步骤（分步，关键公式与推导保留）→ 最终答案（用醒目颜色）。步骤与答案是硬性要求，不许只给答案。",
  "- 图片模糊或无法识别时，用一块板书如实说明「图片无法识别」，不要编造。",
  "- 图片与用户文本同时存在时，将两者内容融合整理，不要割裂成两套板书。",
].join("\n");

// 英文模式附加提示：全部输出（板书/讲稿/图题/解答）强制英文
const EN_LANG_HINT = [
  "",
  "Language (HARD requirement): Write EVERYTHING in English — page title, region headers, every block's text and say (natural spoken English, friendly teacher tone), figure captions, and summary. Keep the circle{}/underline{}/math{} markers exactly as specified. Do not output any Chinese characters.",
].join("\n");

function layoutSystemPrompt(W: number, H: number): string {
  return [
    "你是专业的黑板板书排版引擎兼授课教师。任务：把输入文本（冗长文章、笔记或 Markdown）精炼为「多页、分区、大字、重点分明」的黑板板书，同时为每块内容写口播讲稿。",
    "",
    "输出协议（严格只返回 JSON，无解释、无 markdown 代码块）：",
    '{"pages":[{',
    `  "title": {"text":"页标题","fontSize":${W < H ? 52 : 82},"say":"这一页的开场口播，1~2 句，20~40 字"},`,
    '  "regions": [',
    W < H
      ? `    {"id":"r1","x":25,"y":85,"width":${W - 50},"height":${Math.round(H * 0.42)},"header":"上栏要点"}`
      : `    {"id":"r1","x":60,"y":170,"width":700,"height":660,"header":"栏目标题"},
    {"id":"r2","x":840,"y":170,"width":700,"height":660,"header":"栏目标题"}`,
    "  ],",
    '  "blocks": [',
    `    {"region":"r1","text":"写在黑板上的精简板书","fontSize":${W < H ? 45 : 52},"color":"#f2f0e6","say":"老师口播讲解这一块，自然口语，40~70 字，可展开细节、举例、强调","emphasis":[{"text":"关键词","color":"#ffab6e"}]}`,
    "  ],",
    '  "summary": {"text":"本页核心结论（一句话）","fontSize":48,"color":"#ffe066","say":"总结口播，20~40 字，收束本页"}',
    "}]}",
    "",
    "讲稿规则（say 与 text 分离，讲什么≠写什么）：",
    "- text = 板书：极简短语、关键词、数据，学生抄笔记用的。",
    "- say = 口播：自然口语的讲解，像老师边写边讲；讲稿内容覆盖该块要点，可口语化扩展、举例、强调；不必与 text 一致。",
    "- 口语风格（硬性要求）：像面对面给学生上课聊天，不要书面腔/播音腔——多用自然连接词和口头语：「那么」「然后」「你看」「这个」「那个」「嗯」「对吧」「比如说」「其实」「注意啊」，语气亲和、有温度，允许语气词（呢/啦）；每句都像老师随口说出来的话。语气词「哈」尽量少用（连续听会发腻），整页讲稿最多出现 1 次。示例：\"say\":\"嗯，那么大家看这一步，我们先把 circle{Δ} 算出来，然后呢，它的符号就决定了根的情况，对吧？\"",
    "- 启发式提问（重要）：讲稿适当插入面向学生的问句，勾起好奇、引导思考——如「大家猜猜，如果把这个数换成负的会怎么样？」「为什么这里非用它不可呢？」「你们觉得下一步该从哪儿下手？」；问完稍作停顿再揭晓/继续讲（不用真的等回答，自问自答式推进）。每页讲稿安排 1~3 个这样的问句，放在引出新知识点、对比、转折的位置效果最好。",
    "- 讲稿嵌「板书动作标记」配合讲解：circle{词} = 讲到该词时在黑板上圈出它；underline{词} = 划下划线。标记在转语音时会被剥离，不会读出。",
    "- 标记完备性（硬性要求）：讲稿里每个要点/关键词讲到时都必须带标记——讲三个重点就画三个标记，一个都不能漏；每块讲稿 2~5 个标记。",
    "- 同等强度原则：同一重要级别的信息用同一种标记（最重要的关键词都用 circle，次级要点都用 underline），不许级别相同却标记不同或有的标有的不标。词必须与该块板书 text 原文完全一致。",
    "- 图示（硬性要求）：凡页面内容涉及 流程 / 结构 / 对比 / 关系 / 几何，必须至少 1 个块带 svg 字段（行内 SVG 代码字符串）；用户文本里出现「画图/图/示意/流程」等字样时更必须画，不许用文字替代图。SVG 规格：粉笔线框风——stroke 用 #f2f0e6/#ffe066/#9fd8ff/#ff9ec4，stroke-width 2~3，fill='none' 或半透明，不画背景矩形；viewBox='0 0 400 300'；元素 ≤ 40；少量 <text>（font-size 20~24、fill 用粉笔色；图可能被等比缩小，字号务必 ≥20）；严禁 script/事件/外链。图块 text 可为简短图题，say 配一句讲解。",
    W < H
      ? `- 图示独区+大幅（硬性要求，竖屏）：带 svg 的图示块必须与文字同页共存——图占下方整个区域（≈${Math.round(W * 0.9)}×${Math.round(H * 0.44)}），文字要点在上方区域。严禁图示块与文字要点块混排同一 region，严禁给图开半区，更严禁给图单独开一页。svg 本身要画满：元素铺满整个 viewBox（≥6 个元素），文字/线条大胆用空间——稀疏小图等于没画。`
      : `- 图示独栏+大幅（硬性要求）：带 svg 的图示块必须与文字同页共存——每张图所在页固定两栏布局：一栏文字要点、另一栏整栏（≈700×660）专放图（同主题多图可同栏纵排）。严禁图示块与文字要点块混排同一 region，严禁给图开小栏/半栏，更严禁给图单独开一页（每页两栏都必须有实质内容，不许出现一栏只有区头没有块的空栏）。svg 本身要画满：元素铺满整个 viewBox（≥6 个元素），文字/线条大胆用空间——稀疏小图等于没画。`,
    "- 有图页文字配额（硬性要求）：页面含 svg 图时，文字块总量 ≤ 3 块、每块 ≤ 2 行——图是主角，文字只留最核心要点；内容装不下就拆成更多页（拆页时图与其讲解的文字放同一页），绝不许压缩图来塞文字。",
    "- 禁止「[图]」文字占位（硬性要求）：需要图就必须输出真实的 svg 字段；text 里出现「[图]」「（图）」等占位写法视为错误。",
    "- svg 字段示例（参考写法）：\"<svg viewBox='0 0 400 300' xmlns='http://www.w3.org/2000/svg'><rect x='20' y='20' width='150' height='70' fill='none' stroke='#f2f0e6' stroke-width='3'/><text x='45' y='60' fill='#ffe066' font-size='18'>Query</text><path d='M170 55 L250 55' stroke='#9fd8ff' stroke-width='2'/></svg>\"",
    "- 示例：\"say\":\"先记住 circle{Query} 和 circle{Key} 这两个输入，然后 underline{打分} 得到权重。\"",
    "- 公式转读标记：讲稿(say)里的数学公式/表达式一律用 math{...} 包裹（如 math{a²+b²=c²}、math{3x-5}），系统对 math 段原样直读、不做符号转写；math 外的普通文本中的 - 系统会自动读作「杠」，你不要自己写「杠」字。",
    "",
    "排版规则：",
    W < H
      ? `1. 先分区再写字（核心）：当前是竖屏画布（宽<高）——常用上下分区（上栏要点 / 下栏整幅图示），禁用左右两栏（竖屏每栏太窄）。区域之间留 20~35px 间隙（前端会在间隙画粉笔分隔线）。区域不重叠：x+width ≤ ${W - 60}，y+height ≤ ${H - 140}，页面底部约 50px 留给总结条。`
      : `1. 先分区再写字（核心）：每页先把画布划分为 1~4 个矩形区域——常用左右两栏 / 上下两栏 / 2×2。区域之间留 40~70px 间隙（前端会在间隙画粉笔分隔线）。区域不重叠：x+width ≤ ${W - 60}，y+height ≤ ${H - 140}，页面底部约 100px 留给总结条。`,
    "2. 每个区域一个主题：header ≤ 10 字（黄色区头，自动带下划线）；区域内 2~4 块、每块 1~3 行。内容多就分更多页（1~4 页），每页一个主题，宁可翻页不要拥挤。",
    W < H
      ? "3. 字要大（黑板精髓，远看要清楚；竖屏标题克制）：页标题 48~58（别超过 58，窄画布上大标题喧宾夺主）；区头 45（前端固定）；正文 42~54；总结 45~54。每块 text 控制在 1~2 行（字大行少）。"
      : "3. 字要大（黑板精髓，远看要清楚）：页标题 76~92；区头 60（前端固定，比正文大）；正文 48~62；总结 50~60。每块 text 控制在 1~2 行（字大行少）。",
    "4. 颜色是主要重点手段（8 色粉笔，必须丰富用色，每页至少出现 4~5 种颜色）：",
    "   白 #f2f0e6 正文 ｜ 灰 #d8d8d8 次要说明",
    "   黄 #ffe066 重点/结论/区头 ｜ 橙 #ffab6e 警示/注意/风险",
    "   粉 #ff9ec4 易错/记忆点 ｜ 蓝 #9fd8ff 数据/公式/数字",
    "   绿 #b8f2b8 好处/收益/正向 ｜ 紫 #d8b8ff 例子/引申/注释",
    "   整块换色 + 行内重点词换色搭配使用；summary 必须黄或粉。",
    "5. emphasis 彩色重点词：每页 4~8 个关键词直接指定彩色（比整块更跳脱的颜色）；关键词 ≤ 8 字且必须与所在块 text 原文完全一致。不使用圈选/下划线，纯靠颜色区分。",
    "6. 提纯：删客套话、铺垫、重复；保留论点、数据、结论。板书元素可用 ①②③、→。",
    "7. blocks 只需 region + text + say + fontSize + color + emphasis，不需要 x/y（前端在区域内自动排版）。",
    `画布每页 ${W}x${H} 像素（左上原点）。text 内用 \\n 换行。`,
  ].join("\n");
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
  ".webmanifest": "application/manifest+json",
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
  idleTimeout: 255, // 秒:LLM 流式生成首页常超 10s(默认),SSE 长连接需更大空闲超时(上限 255)
  port: PORT,
  hostname: "0.0.0.0", // 监听局域网：iPad/手机同 WiFi 可直接访问
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";

    try {
      if (path === "/api/health") return Response.json({ ok: true });

      // ---- 生成日志：最近 N 条（内存环形缓冲；?n=50&ok=false 过滤） ----
      if (path === "/api/logs" && req.method === "GET") {
        const n = Math.min(500, Math.max(1, Number(url.searchParams.get("n")) || 50));
        const okFilter = url.searchParams.get("ok"); // "true"/"false" 过滤成败
        const typeFilter = url.searchParams.get("type"); // text2board/ask/tts/asr
        let list = logTail;
        if (okFilter === "true" || okFilter === "false") list = list.filter((l) => l.ok === (okFilter === "true"));
        if (typeFilter) list = list.filter((l) => l.type === typeFilter);
        return Response.json({ ok: true, total: logTail.length, logs: list.slice(-n).reverse() });
      }

      // ---- 客户端语音播放诊断日志落盘（前端 vlog 上报；只收白名单字段） ----
      if (path === "/api/clog" && req.method === "POST") {
        const body = await readJSONBody(req);
        if (body && isStr(body.ev)) {
          appendLog({
            type: "clog",
            ok: body.ev !== "error",
            durationMs: typeof body.at === "number" ? Math.round(body.at * 1000) : 0,
            ip,
            material: `${String(body.ev)} #${String(body.blk ?? "-")} ${isStr(body.text) ? body.text : ""}`.slice(0, 80),
            error: isStr(body.err) ? body.err.slice(0, 120) : undefined,
          });
        }
        return Response.json({ ok: true });
      }

      // ---- 配置：读（密钥打码）/ 写 ----
      if (path === "/api/config" && req.method === "GET") {
        const cfg = loadConfig();
        return Response.json({
          ok: true,
          baseUrl: cfg.baseUrl,
          textModel: cfg.textModel,
          maxRPM: cfg.maxRPM,
          disableThinking: cfg.disableThinking,
          ttsBaseUrl: cfg.ttsBaseUrl,
          ttsModel: cfg.ttsModel,
          ttsVoice: cfg.ttsVoice,
          ttsSpeed: cfg.ttsSpeed,
          font: cfg.font,
          uiFont: cfg.uiFont,
          posterModel: cfg.posterModel,
          grain: cfg.grain,
          theme: cfg.theme,
          lang: cfg.lang,
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
        if (isStr(body.font) && body.font.trim()) cfg.font = body.font.trim().slice(0, 32);
        if (isStr(body.uiFont) && body.uiFont.trim()) cfg.uiFont = body.uiFont.trim().slice(0, 32);
        if (isStr(body.posterModel) && body.posterModel.trim()) cfg.posterModel = body.posterModel.trim().slice(0, 64);
        if (body.theme === "black" || body.theme === "green") cfg.theme = body.theme;
        if (typeof body.grain === "number" && Number.isFinite(body.grain) && body.grain >= 0 && body.grain <= 2.5) cfg.grain = body.grain;
        if (body.lang === "en" || body.lang === "zh") cfg.lang = body.lang;
        writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
        try {
          chmodSync(CONFIG_PATH, 0o600); // 双保险：已有文件也收敛权限
        } catch {
          /* chmod 失败不影响运行 */
        }
        return Response.json({ ok: true });
      }

      // ---- 素材 → 板书（文本及图片；有图走视觉模型） ----
      if (path === "/api/text2board" && req.method === "POST") {
        const body = await readJSONBody(req);
        if (!body) return jsonError("请求体必须是 JSON 对象", 400);
        const hasText = isStr(body.text) && body.text.trim() && body.text.length <= 20_000;
        const rawImages = Array.isArray(body.images) ? body.images.filter(isStr) : [];
        // dataURL 白名单校验：只收 data:image/*;base64，单张 ≤ 6MB（base64 后约 8M 字符）
        const images = rawImages.filter((u) => /^data:image\/(png|jpe?g|webp|gif);base64,/.test(u) && u.length <= 8_000_000).slice(0, 4);
        if (!hasText && images.length === 0) return jsonError("text 或 images 至少一项非空", 400);
        if (isStr(body.text) && body.text.length > 20_000) return jsonError("text 过长（上限 2 万字符）", 400);
        const W = typeof body.canvasW === "number" ? body.canvasW : 1600;
        const H = typeof body.canvasH === "number" ? body.canvasH : 1000;

        const cfg = loadConfig();
        if (!cfg.apiKey) return jsonError("未配置 API Key，请先在「设置」中填写", 400);
        if (!allowRequest(ip, cfg.maxRPM)) return jsonError(`请求过于频繁，限流 ${cfg.maxRPM} 次/分钟`, 429);
        const t2bStart = Date.now();
        const material = summarizeMaterial(hasText ? body.text : `（${images.length} 张图片）`);
        const t2bLog = (extra: Partial<GenLog>) =>
          appendLog({
            type: "text2board", ok: true, durationMs: Date.now() - t2bStart, ip,
            model, lang: body.lang === "en" ? "en" : "zh", stream: !!body.stream,
            material, images: images.length, ...extra,
          });

        // 图片存在 → 视觉模型多模态输入（文本+图）；否则纯文本走排版模型
        const useVision = images.length > 0;
        const model = useVision ? cfg.visionModel : cfg.textModel;
        const systemPrompt = layoutSystemPrompt(W, H) + (useVision ? IMAGE_HINT : "") + (body.lang === "en" ? EN_LANG_HINT : "");
        const userContent: ChatMessage["content"] = useVision
          ? [
              {
                type: "text",
                text: hasText
                  ? `用户素材：\n${body.text}\n\n（另附 ${images.length} 张图片，见上）`
                  : `用户素材为 ${images.length} 张图片，请识别后生成板书。`,
              },
              ...images.map((url) => ({ type: "image_url" as const, image_url: { url } })),
            ]
          : body.text as string;
        const messages: ChatMessage[] = [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
        ];

        // 流式模式（stream=1）：SSE 逐页推送——LLM 每写完一页 JSON 就推给前端先讲，
        // 首页到达时间 ≈ 生成总时长/页数，后续页在讲解期间继续生成。
        if (body.stream) {
          const encoder = new TextEncoder();
          const stream = new ReadableStream({
            async start(controller) {
              const send = (event: string, data: unknown) => {
                controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
              };
              try {
                let scanFrom = 0;
                let pushed = 0;
                let content = "";
                send("open", { ok: true });
                content = await callLLMStream(cfg, model, messages, 8192, (full) => {
                  const [newPages, next] = extractNewPages(full, scanFrom);
                  scanFrom = next;
                  for (const pg of newPages) {
                    const board = normalizeBoard(pg, W, H);
                    if (board.title || board.blocks.length > 0 || board.summary) {
                      pushed++;
                      send("page", board);
                    }
                  }
                });
                // 全量兜底：流式提取漏页（如模型输出非标准结构）→ 结束时全量解析补发差异
                const all = normalizePages(extractJSON(content), W, H).filter(
                  (p) => p.title !== null || p.blocks.length > 0 || p.summary !== null,
                );
                if (all.length > pushed) {
                  for (let i = pushed; i < all.length; i++) send("page", all[i]);
                }
                send("done", { ok: true, pages: all.length });
                t2bLog({ pages: all.length, blocks: all.reduce((n, p) => n + p.blocks.length, 0) });
                controller.close();
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                send("error", { ok: false, error: msg.slice(0, 400) });
                t2bLog({ ok: false, error: msg.slice(0, 200) });
                controller.close();
              }
            },
          });
          return new Response(stream, {
            headers: {
              "Content-Type": "text/event-stream; charset=utf-8",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            },
          });
        }

        try {
          const content = await callLLM(cfg, model, messages, 8192);
          const pages = normalizePages(extractJSON(content), W, H).filter(
            (p) => p.title !== null || p.blocks.length > 0 || p.summary !== null,
          );
          if (pages.length === 0) {
            t2bLog({ ok: false, error: "模型未返回有效板书 JSON" });
            return jsonError("模型未返回有效板书 JSON，请重试", 502);
          }

        // 两段式补图：内容有图示语义但主生成没画 → 专门再调一次画图
        const hasSvg = pages.some((p) => p.blocks.some((b) => b.svg !== undefined));
        const boardSummary = pages
          .map((p) => [p.title?.text ?? "", ...p.regions.map((r) => r.header ?? ""), ...p.blocks.map((b) => b.text)].filter(Boolean).join("\n"))
          .join("\n")
          .slice(0, 1200);
        const wantsFigure = boardSummary.length > 10; // 内容足够就有配图价值，默认尝试
        if (!hasSvg && wantsFigure) {
          try {
            const figContent = await callLLM(cfg, cfg.textModel, [{ role: "user", content: figurePrompt(boardSummary, body.lang === "en") }], 4096);
            const figRaw = extractJSON(figContent);
            const figList = Array.isArray(figRaw) ? figRaw : [figRaw];
            const target = pages.find((p) => p.regions.length > 0 && p.blocks.length > 0) ?? pages[0];
            // 补图放入「无文字块的区域」（模型常漏画的整栏空区）；没有空区才退回 regions[0]（前端图独栏兜底会再处理）
            const usedRegionIds = new Set(target.blocks.filter((b) => !b.svg).map((b) => b.region));
            const emptyRegions = target.regions.filter((r) => !usedRegionIds.has(r.id));
            let n = 0;
            for (const f of figList) {
              if (!isRecord(f)) continue;
              const svg = sanitizeSvg(f.svg);
              if (!svg || n >= 2) continue;
              const region = emptyRegions[n] ?? target.regions[0];
              target.blocks.push({
                id: `figure${++n}`,
                text: isStr(f.text) && f.text.trim() ? f.text.trim().slice(0, 24) : "图",
                x: 60,
                y: 300,
                width: 640,
                fontSize: 36,
                color: "#f2f0e6",
                ...(region ? { region: region.id } : {}),
                ...(isStr(f.say) && f.say.trim() ? { say: f.say.trim().slice(0, 400) } : {}),
                svg,
              });
            }
          } catch {
            /* 补图失败不影响板书返回 */
          }
        }
        t2bLog({ pages: pages.length, blocks: pages.reduce((n, p) => n + p.blocks.length, 0) });
        return Response.json({ ok: true, pages, raw: content.length > 2000 ? content.slice(0, 2000) : content });
        } catch (err) {
          t2bLog({ ok: false, error: (err instanceof Error ? err.message : String(err)).slice(0, 200) });
          throw err;
        }
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

        const askStart = Date.now();
        try {
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
      "要求：结合上下文解释这行字在讲什么；像老师当面给学生答疑——口语化、亲和，多用「你看」「那么」「就是说」「对吧」「比如说」这类口头语，允许语气词；25~60 字；不要复述问题，不要书面腔。若回答含公式/表达式，用 math{...} 包裹（系统直读不转写）；图注类前缀【图】禁止出现。",
      ...(body.lang === "en" ? ["Language: answer entirely in English (conversational teacher tone, 15~40 words)."] : []),
      '严格只返回 JSON（无解释无代码块）：{"text":"解释内容"}',
                ].join("\n"),
              },
              { role: "user", content: `这行是什么意思？「${line}」` },
            ],
            1024,
          );
          const parsed = extractJSON(content);
          const text = isRecord(parsed) && isStr(parsed.text) && parsed.text.trim() ? parsed.text.trim().slice(0, 120) : "";
          if (!text) {
            appendLog({ type: "ask", ok: false, durationMs: Date.now() - askStart, ip, model: cfg.textModel, material: summarizeMaterial(line), lang: body.lang === "en" ? "en" : "zh", error: "模型未返回有效解释" });
            return jsonError("模型未返回有效解释，请重试", 502);
          }
          appendLog({ type: "ask", ok: true, durationMs: Date.now() - askStart, ip, model: cfg.textModel, material: summarizeMaterial(line), lang: body.lang === "en" ? "en" : "zh" });
          return Response.json({ ok: true, text });
        } catch (err) {
          appendLog({ type: "ask", ok: false, durationMs: Date.now() - askStart, ip, model: cfg.textModel, material: summarizeMaterial(line), lang: body.lang === "en" ? "en" : "zh", error: (err instanceof Error ? err.message : String(err)).slice(0, 200) });
          throw err;
        }
      }

      // ---- 按住说话：语音识别（SiliconFlow /audio/transcriptions，密钥复用 TTS 配置） ----
      if (path === "/api/asr" && req.method === "POST") {
        const cfg = loadConfig();
        if (!cfg.ttsApiKey) return jsonError("未配置 TTS/ASR API Key，请先在「设置」中填写", 400);
        const form = await req.formData();
        const file = form.get("file");
        const model = form.get("model");
        if (!(file instanceof File) || file.size === 0) return jsonError("音频文件缺失", 400);
        if (file.size > 20_000_000) return jsonError("音频过大（上限 20MB）", 400);
        const upstream = new FormData();
        // 默认 Qwen3-ASR:实测 0.6-1.4s(SenseVoiceSmall 4.9s 且偶发错字"勾→股"),快 8 倍更准
        upstream.append("model", typeof model === "string" && /^[\w/.-]+$/.test(model) ? model : "Qwen/Qwen3-ASR-1.7B");
        upstream.append("file", file, file.name || "speech.webm");
        const asrStart = Date.now();
        const asrModel = typeof model === "string" && /^[\w/.-]+$/.test(model) ? model : "Qwen/Qwen3-ASR-1.7B";
        try {
          const asrRes = await fetch(cfg.ttsBaseUrl.replace(/\/+$/, "") + "/audio/transcriptions", {
            method: "POST",
            headers: { Authorization: `Bearer ${cfg.ttsApiKey}` },
            body: upstream,
            signal: AbortSignal.timeout(120_000),
          });
          if (!asrRes.ok) {
            const errText = (await asrRes.text()).slice(0, 300);
            appendLog({ type: "asr", ok: false, durationMs: Date.now() - asrStart, ip, model: asrModel, material: `音频 ${(file.size / 1000).toFixed(0)}KB`, error: `ASR ${asrRes.status}` });
            return jsonError(`ASR 服务返回 ${asrRes.status}: ${errText}`, 502);
          }
          const data: unknown = await asrRes.json();
          const text = isRecord(data) && isStr(data.text) ? data.text : "";
          appendLog({ type: "asr", ok: true, durationMs: Date.now() - asrStart, ip, model: asrModel, material: summarizeMaterial(text) || "（无识别结果）" });
          return Response.json({ ok: true, text });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          appendLog({ type: "asr", ok: false, durationMs: Date.now() - asrStart, ip, model: asrModel, material: `音频 ${(file.size / 1000).toFixed(0)}KB`, error: msg.slice(0, 200) });
          return jsonError(msg.slice(0, 400), 500);
        }
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



        const ttsStart = Date.now();
        try {
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
          appendLog({ type: "tts", ok: true, durationMs: Date.now() - ttsStart, ip, model: cfg.ttsModel, material: summarizeMaterial(text) });
          return Response.json({ ok: true, audio: `data:audio/mpeg;base64,${btoa(bin)}` });
        } catch (err) {
          appendLog({ type: "tts", ok: false, durationMs: Date.now() - ttsStart, ip, model: cfg.ttsModel, material: summarizeMaterial(text), error: (err instanceof Error ? err.message : String(err)).slice(0, 200) });
          throw err;
        }
      }


      // ---- 画板报：素材 → 粉笔简笔画提示词 → 文生图 → 黑底转透明 → base64 PNG ----
      if (path === "/api/poster" && req.method === "POST") {
        const body = await readJSONBody(req);
        if (!body) return jsonError("请求体必须是 JSON 对象", 400);
        const theme = isStr(body.theme) ? body.theme.trim().slice(0, 200) : "";
        if (!theme) return jsonError("theme（板报主题素材）不能为空", 400);
        const cfg = loadConfig();
        if (!cfg.ttsApiKey) return jsonError("未配置 SiliconFlow API Key，请先在「设置」中填写", 400);
        if (!allowRequest(ip, cfg.maxRPM)) return jsonError(`请求过于频繁，限流 ${cfg.maxRPM} 次/分钟`, 429);
        const start = Date.now();
        const posterLog = (extra: Partial<GenLog>) => appendLog({
          type: "poster", ok: true, durationMs: Date.now() - start, ip, model: cfg.posterModel,
          material: summarizeMaterial(theme), ...extra,
        });
        try {
          // 提示词与讲课完全不同：彩色线条粉笔简笔画（严格无填充）——用户指定模板
          const en = body.lang === "en";
          const styleZh = "简笔画，黑板报风格粉笔简笔画，手绘粉笔线条，线条轻微抖动不光滑，简笔，线条一定使用彩色粉笔，色彩表现在线条上，干净轮廓，一定不要填充，无阴影，无渐变，画面留白充足，2D 平面插画，高对比度，边缘干净，不要背景，纯黑背景。画面中的文字也必须是手写粉笔字风格，笔画粗糙带粉尘感；画面元素丰富一些，围绕主题安排多种小元素和装饰。";
          const styleEn = "simple sketch, blackboard bulletin chalk drawing, hand-drawn chalk lines, slightly shaky imperfect lines, minimal style, lines MUST use colored chalks (color lives in the lines only), clean outlines, STRICTLY NO FILLS, no shadows, no gradients, generous empty space, flat 2D illustration, high contrast, clean edges, no background, pure black background. Any text in the picture must be hand-written chalk lettering with rough dusty strokes; make the composition rich with varied small elements and decorations around the theme.";
          const prompt = en
            ? `${theme} themed classroom blackboard bulletin, children happily going to school, simple sketch. ${styleEn}`
            : `${theme}为主题的黑板报，简笔画，有同学们上学的开心的画面。${styleZh}`;
          const imgRes = await fetch(cfg.ttsBaseUrl.replace(/\/+$/, "") + "/images/generations", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.ttsApiKey}` },
            body: JSON.stringify({
              model: cfg.posterModel,
              prompt,
              image_size: "1280x720",
              batch_size: 1,
            }),
            signal: AbortSignal.timeout(120_000),
          });
          if (!imgRes.ok) {
            const errText = (await imgRes.text()).slice(0, 300);
            throw new Error(`文生图服务返回 ${imgRes.status}: ${errText}`);
          }
          const imgData: unknown = await imgRes.json();
          const imgUrl = isRecord(imgData) && Array.isArray(imgData.images) && isRecord(imgData.images[0]) && isStr(imgData.images[0].url) ? imgData.images[0].url : "";
          if (!imgUrl) throw new Error("文生图响应缺少图片 URL");
          // 拉回图片字节（URL 是临时存储，必须立刻取回处理）
          const pngRes = await fetch(imgUrl, { signal: AbortSignal.timeout(60_000) });
          if (!pngRes.ok) throw new Error(`图片下载失败 ${pngRes.status}`);
          const pngBytes = new Uint8Array(await pngRes.arrayBuffer());
          // 黑底 → 透明（粉笔线条保留），失败则原图返回（黑色画到黑板上也不违和）
          let outPng = pngBytes;
          try {
            outPng = blackToAlphaPng(pngBytes);
          } catch (e) {
            console.error("黑转透明失败（按原图返回）:", e instanceof Error ? e.message : e);
          }
          let bin = "";
          for (let i = 0; i < outPng.length; i += 0x8000) {
            bin += String.fromCharCode(...outPng.subarray(i, i + 0x8000));
          }
          const poster = {
            version: 1,
            kind: "poster",
            theme,
            lang: en ? "en" : "zh",
            model: cfg.posterModel,
            image: `data:image/png;base64,${btoa(bin)}`, // 前端直接 img/canvas 绘制
            createdAt: new Date().toISOString(),
          };
          posterLog({});
          return Response.json({ ok: true, poster });
        } catch (err) {
          posterLog({ ok: false, error: (err instanceof Error ? err.message : String(err)).slice(0, 200) });
          return jsonError((err instanceof Error ? err.message : String(err)).slice(0, 400), 502);
        }
      }

      // ---- 静态文件 ----
      // HTML / manifest 必须 no-store：Safari「加入主屏幕」的 PWA 独立存储缓存极激进，
      // no-cache 仍可能吃旧 HTML → 引用旧 app.js（宋体问题根源）
      const rel = path === "/" ? "/index.html" : path;
      const file = join(PUBLIC_DIR, rel);
      if (!file.startsWith(PUBLIC_DIR)) return new Response("Forbidden", { status: 403 });
      const f = Bun.file(file);
      if (await f.exists()) {
        const nocache = /\.(html|webmanifest)$/.test(file) || path === "/";
        const headers = { "Content-Type": MIME[extname(file)] ?? "application/octet-stream" };
        headers["Cache-Control"] = nocache ? "no-store" : "no-cache";
        return new Response(f, { headers });
      }
      return new Response("Not Found", { status: 404 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[ERR] ${req.method} ${path}:`, msg);
      return jsonError(msg.slice(0, 500), 500);
    }
  },
});

const lanIP = Object.values(import.meta.require?.("node:os").networkInterfaces?.() ?? {}).flat().find((i) => i && i.family === "IPv4" && !i.internal)?.address;
console.log(`敲黑板已启动: http://127.0.0.1:${PORT}${lanIP ? ` （局域网: http://${lanIP}:${PORT}，iPad/手机同 WiFi 访问后「加入主屏幕」即成 App）` : ""}`);
