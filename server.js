/**
 * ============================================================
 * Thai & English Name Bi-Directional Transliteration API v4.3
 * (Node.js Port with Python Server parity: Match, Claim/Release, Overrides, Logging)
 * ============================================================
 *
 * FEATURES:
 * 1. TH -> EN & EN -> TH Transliteration & Translation
 * 2. Dynamic `name_overrides.txt` support
 * 3. `/match` endpoint: เทียบเฉพาะ "ชื่อจริงคำแรก" (ตัดคำนำหน้า+นามสกุล) ไทย<->อังกฤษ ทั้งสองทิศทาง & `translate_misses.log`
 *    (v4.1: /translate แปลเฉพาะชื่อจริง, name_overrides.txt แก้แล้วมีผลทันที, Google ล้มเหลว = คืน failed ไม่เดาผลแปล)
 * 4. `/claim` & `/release` cross-profile order locking with 2-minute TTL
 * 5. `/engines` & `/health` endpoints
 * 6. Ultra Sleek Terminal Logger Display
 * 7. unmatched_names.txt: บันทึกชื่อที่ "แปล/จับคู่ไม่สำเร็จ" และชื่อที่ "ผ่านแต่ความเหมือนต่ำกว่า 70%" (ชื่อซ้ำไม่ลงซ้ำ)
 *
 * วิธีติดตั้ง:
 * npm install express cors
 *
 * วิธีรัน:
 * node server.js
 * ============================================================
 */

const express = require('express');
const cors = require('cors');
const https = require('https');
const fs = require('fs');
const path = require('path');

// เขียนไฟล์แบบ atomic: เขียนลงไฟล์ชั่วคราวก่อนแล้วค่อยเปลี่ยนชื่อทับ -> ถ้าโปรแกรมถูกปิดกลางคันไฟล์เดิมจะไม่ถูกตัดเหลือ 0 ไบต์
function writeFileAtomic(file, data) {
    const tmp = `${file}.${process.pid}.tmp`;
    try {
        fs.writeFileSync(tmp, data, 'utf-8');
        fs.renameSync(tmp, file);
    } catch (e) {
        try { fs.unlinkSync(tmp); } catch (_) { /* ไม่มีไฟล์ชั่วคราวให้ลบ */ }
        fs.writeFileSync(file, data, 'utf-8');   // สำรอง: บาง Windows ล็อกไฟล์ปลายทางชั่วคราว (โปรแกรมสแกนไวรัส/OneDrive)
    }
}

const app = express();
const PORT = 5001;
const HOST = '127.0.0.1';

// ============================================================
// ANSI Color Codes & Sleek Console Logger
// ============================================================
const C = {
    reset: "\x1b[0m",
    bold: "\x1b[1m",
    dim: "\x1b[2m",
    red: "\x1b[38;5;196m",
    green: "\x1b[38;5;46m",
    yellow: "\x1b[38;5;226m",
    blue: "\x1b[38;5;39m",
    magenta: "\x1b[38;5;201m",
    cyan: "\x1b[38;5;51m",
    white: "\x1b[38;5;231m",
    gray: "\x1b[38;5;244m",
    orange: "\x1b[38;5;208m",
    bgCyan: "\x1b[48;5;51m\x1b[38;5;16m\x1b[1m",
    bgMagenta: "\x1b[48;5;201m\x1b[38;5;16m\x1b[1m",
    bgGreen: "\x1b[48;5;46m\x1b[38;5;16m\x1b[1m",
    bgYellow: "\x1b[48;5;226m\x1b[38;5;16m\x1b[1m",
    bgBlue: "\x1b[48;5;39m\x1b[38;5;16m\x1b[1m",
    bgRed: "\x1b[48;5;196m\x1b[38;5;231m\x1b[1m",
    underline: "\x1b[4m"
};

function getTimestamp() {
    const now = new Date();
    const ms = String(now.getMilliseconds()).padStart(3, '0');
    return `${now.toTimeString().split(' ')[0]}.${ms}`;
}

function getEngineBadge(engine) {
    switch (engine) {
        case 'dictionary': return `${C.bgMagenta} DICTIONARY ${C.reset}`;
        case 'google_translate': return `${C.bgYellow} GOOGLE_TR ${C.reset}`;
        case 'offline_rules': return `${C.bgYellow} OFFLINE ${C.reset}`;
        case 'failed': return `${C.bgRed} FAILED ${C.reset}`;
        case 'dictionary+transliteration': return `${C.bgBlue} HYBRID ${C.reset}`;
        default: return `${C.bgCyan} GOOGLE_RM ${C.reset}`;
    }
}

function getMsBadge(duration) {
    if (duration < 50) return `${C.green}${C.bold}${duration}ms${C.reset}`;
    if (duration < 200) return `${C.yellow}${C.bold}${duration}ms${C.reset}`;
    return `${C.red}${C.bold}${duration}ms${C.reset}`;
}

function logSleekRequest(method, endpoint, statusCode, resData, duration) {
    const timestamp = `${C.gray}[${getTimestamp()}]${C.reset}`;
    const methodBadge = `${C.bgGreen} ${method} ${C.reset}`;
    const statusBadge = statusCode === 200 ? `${C.green}200 OK${C.reset}` : `${C.red}${statusCode} ERR${C.reset}`;
    const ms = getMsBadge(duration);
    const engine = getEngineBadge(resData.engine || 'none');
    const dirMap = { TH_TO_EN: `${C.cyan}[TH ➔ EN]${C.reset}`, EN_TO_TH: `${C.orange}[EN ➔ TH]${C.reset}`, TH_TO_TH: `${C.cyan}[TH ➔ TH]${C.reset}`, EN_TO_EN: `${C.orange}[EN ➔ EN]${C.reset}` };
    const directionBadge = dirMap[resData.direction] || `${C.gray}[--]${C.reset}`;

    console.log(`\n${timestamp} ${methodBadge} ${C.cyan}${C.bold}${endpoint}${C.reset} (${statusBadge}) ${directionBadge} ── ${ms}`);
    console.log(`  ${C.gray}├─${C.reset} ${C.gray}INPUT   :${C.reset} ${C.yellow}${C.bold}"${resData.input || resData.order || ''}"${C.reset}`);
    console.log(`  ${C.gray}├─${C.reset} ${C.gray}OUTPUT  :${C.reset} ${C.green}${C.bold}"${resData.translated || (resData.percent !== undefined ? resData.percent + '%' : (resData.failed ? '(translation unavailable)' : ''))}"${C.reset}`);
    if (resData.isMatch !== undefined) {
        const matchStatus = resData.isMatch ? `${C.green}MATCH${C.reset}` : `${C.red}MISMATCH${C.reset}`;
        console.log(`  ${C.gray}├─${C.reset} ${C.gray}MATCH   :${C.reset} ${matchStatus} (Trust: ${resData.trust}, Percent: ${resData.percent}%)`);
    }
    console.log(`  ${C.gray}└─${C.reset} ${C.gray}ENGINE  :${C.reset} ${engine}`);
}

// ============================================================
// Middleware
// ============================================================
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ============================================================
// Dictionary & Overrides (Supports name_overrides.txt)
// ============================================================
const DEFAULT_OVERRIDES = {
    "มนต์นที": "MONNATEE",
    "รักนะ": "LUCKNA",
    "พัดวัง": "PADWANG",
    "ปัญญา": "PANYA",
    "ธนาบัตร": "THANABAT",
    "สมชาย": "SOMCHAI",
    "สุนิสา": "SUNISA",
    "ทองอินทร์": "THONG IN",
    "กิตติ": "KITTI",
    "กิตติศักดิ์": "KITTISAK",
    "อนุชา": "ANUCHA",
    "อนันต์": "ANAN",
    "พงษ์": "PHONG",
    "พงษ์ศักดิ์": "PHONGSAK",
    "สุรชัย": "SURACHAI",
    "วราภรณ์": "WARAPORN",
    "ศิริพร": "SIRIPORN",
    "นภัส": "NAPHAT",
    "ณัฐวุฒิ": "NATTAWUT",
    "แสงเดือน": "SAENGDUEAN",
    "ชลธิชา": "CHONTHICHA"
};

let NAME_OVERRIDES_TH_TO_EN = { ...DEFAULT_OVERRIDES };   // ชื่อไทย -> สะกดอังกฤษ "ล่าสุด" (คงไว้เพื่อความเข้ากันได้กับโค้ดเดิม)
let NAME_OVERRIDES_ALTS = {};                              // ชื่อไทย -> [ทุกการสะกดอังกฤษที่รู้จัก] (ใช้จับคู่)
const OVERRIDES_FILE = path.join(__dirname, 'name_overrides.txt');
const MISS_LOG_FILE = path.join(__dirname, 'translate_misses.log');
let _overridesMtime = -2;
let overrideWarnings = [];

// ตรวจ name_overrides.txt หาบรรทัดที่น่าจะผิด (เช่น ชื่อภาษาอังกฤษไม่มีสระ/ใช้ซ้ำกับหลายชื่อไทย/ใส่คำนำหน้าเป็นชื่อ)
function validateOverrides() {
    const warns = [];
    const byEn = {};
    for (const [th, alts] of Object.entries(NAME_OVERRIDES_ALTS)) {
        for (const en of alts) {
            const k = String(en).toUpperCase().replace(/[^A-Z]/g, '');
            if (!k) { warns.push(`"${th} = ${en}" ชื่ออังกฤษไม่มีตัวอักษร A-Z`); continue; }
            (byEn[k] = byEn[k] || new Set()).add(th);
            if (!/[AEIOU]/.test(k) && k.length <= 6) warns.push(`"${th} = ${en}" ชื่ออังกฤษไม่มีสระ น่าจะไม่ใช่ชื่อคน (เช่น ชื่อกระเป๋าเงินอิเล็กทรอนิกส์)`);
        }
        if (/^(ว่าที่|นาย|นาง|นางสาว|เด็กชาย|เด็กหญิง|ดร|คุณ)$/.test(th)) warns.push(`"${th}" เป็นคำนำหน้า ไม่ใช่ชื่อ ไม่ควรใส่ใน name_overrides.txt`);
    }
    for (const [k, set] of Object.entries(byEn)) {
        if (set.size >= 3) warns.push(`"${k}" ถูกใช้กับ ${set.size} ชื่อไทยที่ต่างกัน (${[...set].slice(0, 4).join(', ')}) น่าจะผิด ถ้าสลิปเป็นชื่อนี้ จะจับคู่ได้ทั้งหมด`);
    }
    return warns;
}

function resetOverridesToDefault() {
    NAME_OVERRIDES_TH_TO_EN = { ...DEFAULT_OVERRIDES };
    NAME_OVERRIDES_ALTS = {};
    for (const [th, en] of Object.entries(DEFAULT_OVERRIDES)) NAME_OVERRIDES_ALTS[th] = [String(en).toUpperCase()];
}

function loadOverrides() {
    resetOverridesToDefault();
    try {
        if (fs.existsSync(OVERRIDES_FILE)) {
            _overridesMtime = fs.statSync(OVERRIDES_FILE).mtimeMs;
            const content = fs.readFileSync(OVERRIDES_FILE, 'utf-8').replace(/^\uFEFF/, '');
            const lines = content.split(/\r?\n/);
            let count = 0;
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith('#')) continue;
                const idx = trimmed.indexOf('=');
                if (idx <= 0) continue;
                const th = normalizeSpaces(trimmed.slice(0, idx));
                const en = normalizeSpaces(trimmed.slice(idx + 1)).toUpperCase();
                if (th && en) {
                    NAME_OVERRIDES_TH_TO_EN[th] = en;
                    if (!NAME_OVERRIDES_ALTS[th]) NAME_OVERRIDES_ALTS[th] = [];
                    // ชื่อไทยเดียวกันเขียนหลายบรรทัด = สะกดได้หลายแบบ -> เก็บไว้ทุกแบบ
                    if (!NAME_OVERRIDES_ALTS[th].includes(en)) NAME_OVERRIDES_ALTS[th].push(en);
                    count++;
                }
            }
            console.log(`[Overrides] Loaded ${count} custom overrides from name_overrides.txt`);
            overrideWarnings = validateOverrides();
            for (const w of overrideWarnings) console.warn(`[Overrides] ⚠️ ${w}`);
        } else {
            _overridesMtime = -1;
        }
    } catch (e) {
        console.error('[Overrides] Error loading name_overrides.txt:', e.message);
    }
}

// name_overrides.txt แก้แล้วใช้ได้ทันที (ตามที่ระบุในไฟล์) -> ตรวจเวลาแก้ไขไฟล์ทุกครั้งที่แปล/จับคู่
function ensureOverridesFresh() {
    try {
        const mt = fs.existsSync(OVERRIDES_FILE) ? fs.statSync(OVERRIDES_FILE).mtimeMs : -1;
        if (mt !== _overridesMtime) loadOverrides();
    } catch (e) { /* ใช้ค่าเดิมต่อไป */ }
}
loadOverrides();

// ============================================================
// Title Mapping
// ============================================================
const TITLE_MAP_TH_TO_EN = {
    'นาย': 'MR', 'นาง': 'MRS', 'นางสาว': 'MISS', 'เด็กชาย': 'MASTER', 'เด็กหญิง': 'MISS',
    'น.ส.': 'MISS', 'ด.ช.': 'MASTER', 'ด.ญ.': 'MISS', 'ดร.': 'DR'
};
const TITLE_MAP_EN_TO_TH = {
    'MR': 'นาย', 'MRS': 'นาง', 'MISS': 'นางสาว', 'MS': 'นางสาว', 'MASTER': 'เด็กชาย', 'DR': 'ดร.'
};

function isThai(text) {
    if (!text) return false;
    return /[\u0E00-\u0E7F]/.test(text);
}

function normalizeSpaces(text) {
    if (!text) return '';
    return String(text)
        .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')   // zero-width ที่มักติดมาจากการ copy ชื่อ
        .replace(/\s+/g, ' ')
        .trim();
}

// คำนำหน้าไทยที่ชัดเจน (ติดกับชื่อได้ เช่น "นายสมชาย", "น.ส.ปภาดา")
const TH_TITLE_RE_STRICT = /^(เด็กหญิง|เด็กชาย|นางสาว|น\.\s?ส\.?|ด\.\s?ช\.?|ด\.\s?ญ\.?|นาย|นาง)\s*/;
// คำนำหน้าที่กำกวม (อาจเป็นต้นชื่อจริง เช่น "คุณากร") -> ต้องมีจุดหรือเว้นวรรคตามหลัง
const TH_TITLE_RE_SEP = /^(นส|ดช|ดญ|ดร|คุณ)(?:\.\s*|\s+)/;
const EN_TITLE_RE = /^(MRS|MR|MS|MISS|MASTER|MSTR|DR|PROF|KHUN)(?:\.\s*|\s+)/i;
const EN_TITLE_ONLY_RE = /^(MRS|MR|MS|MISS|MASTER|MSTR|DR|PROF|KHUN)\.?$/i;
// ยศ/คำนำหน้าอื่น ๆ ที่พบบนสลิป เช่น "ว่าที่ร้อยตรีหญิง", "ร.ต.อ.", "ดร.", "ACTING SUB LT."
const TH_TITLE_MIL_RE = /^ว่าที่\s?(?:(?:ร้อย|พัน)(?:ตรี|โท|เอก)|ร\.?[ตทอ]\.?|พ\.?[ตทอ]\.?)(?:\s?หญิง)?\s*/;
const TH_TITLE_DOTTED_RE = /^(?:(?:[ก-ฮ]\.){2,4}|(?:ดร|ผศ|รศ|ศ|นพ|พญ|ทพ|ภก|ภญ)\.)\s*(?=[ก-ฮเ-ไ])/;
const EN_TITLE_MIL_RE = /^(?:ACTING\s+)?(?:(?:POL\.?\s*)?(?:GEN|COL|LT|CAPT|MAJ|SGT)|SUB\s*LT|ASST?\.?\s*PROF|ASSOC\.?\s*PROF|REV)(?:\.\s*|\s+)/i;
const EN_TRAILING_TITLE_RE = /\s+(MRS|MR|MS|MISS)\.?$/i;   // เช่น "PRAASAN PROMMEEDET MR"

function thTitleToEn(raw) {
    const t = raw.replace(/\s/g, '');
    if (t.startsWith('เด็กหญิง')) return 'MISS';
    if (t.startsWith('เด็กชาย')) return 'MASTER';
    if (t.startsWith('นางสาว')) return 'MISS';
    if (t.startsWith('นาย')) return 'MR';
    if (t.startsWith('นาง')) return 'MRS';
    if (/^(น\.?ส)/.test(t)) return 'MISS';
    if (/^(ด\.?ช)/.test(t)) return 'MASTER';
    if (/^(ด\.?ญ)/.test(t)) return 'MISS';
    if (/^ดร/.test(t)) return 'DR';
    return null;   // "คุณ" ไม่ระบุเพศ
}

// ตัดคำนำหน้า (ไทย/อังกฤษ, ซ้อนกันได้, มีจุดหรือไม่มีเว้นวรรคก็ได้, คำนำหน้าท้ายชื่อ) -> คืนชื่อเต็มที่ไม่มีคำนำหน้า
function stripNameTitles(text) {
    let s = normalizeSpaces(String(text || '').replace(/\([^)]*\)/g, ' '));   // ตัดข้อความในวงเล็บ เช่น "(ธนาคารกสิกรไทย)"
    let titleTh = null, titleEn = null;
    for (let i = 0; i < 5; i++) {
        const before = s;
        let m;
        if ((m = s.match(TH_TITLE_RE_STRICT)) || (m = s.match(TH_TITLE_RE_SEP))) {
            const en = thTitleToEn(m[1]);
            if (!titleEn && en) { titleEn = en; titleTh = m[1].replace(/\s/g, ''); }
            s = s.slice(m[0].length).trim();
        } else if ((m = s.match(EN_TITLE_RE))) {
            const en = m[1].toUpperCase() === 'MSTR' ? 'MASTER' : m[1].toUpperCase();
            if (!titleEn) { titleEn = en; titleTh = TITLE_MAP_EN_TO_TH[en] || ''; }
            s = s.slice(m[0].length).trim();
        } else if ((m = s.match(TH_TITLE_MIL_RE)) || (m = s.match(TH_TITLE_DOTTED_RE))) {
            s = s.slice(m[0].length).trim();
        } else if ((m = s.match(EN_TITLE_MIL_RE))) {
            s = s.slice(m[0].length).trim();
        } else if (EN_TITLE_ONLY_RE.test(s)) {
            s = '';
        }
        if (s === before) break;
    }
    if (s.includes(' ')) {
        const m = s.match(EN_TRAILING_TITLE_RE);
        if (m) {
            const en = m[1].toUpperCase();
            if (!titleEn) { titleEn = en; titleTh = TITLE_MAP_EN_TO_TH[en] || ''; }
            s = s.slice(0, s.length - m[0].length).trim();
        }
    }
    return { rest: s, titleTh, titleEn };
}

// โครงสร้างเดิม: คืน { cleaned, titleTh, titleEn } (cleaned = ชื่อเต็มที่ตัดคำนำหน้าแล้ว)
function extractTitle(text) {
    const { rest, titleTh, titleEn } = stripNameTitles(text);
    return { cleaned: rest, titleTh, titleEn };
}

// ดึง "ชื่อจริงคำแรก": ตัดคำนำหน้า -> เอาคำแรก -> ตัดสัญลักษณ์หัวท้าย (นามสกุลถูกทิ้ง)
function extractFirstName(text) {
    const { rest, titleTh, titleEn } = stripNameTitles(text);
    let first = '';
    for (const tok of rest.split(' ')) {
        if (/[A-Za-z\u0E00-\u0E7F]/.test(tok)) { first = tok; break; }
    }
    first = first.replace(/^[^A-Za-z\u0E00-\u0E7F]+|[^A-Za-z\u0E00-\u0E7F]+$/g, '');
    const lang = !first ? 'NONE' : (isThai(first) ? 'TH' : 'EN');
    return { first, rest, titleTh, titleEn, lang };
}

// กรณีผู้เรียกส่ง "ชื่อจริง" มาแล้ว (firstOnly=1) -> ไม่ตัดคำนำหน้าซ้ำ
function parseFirstOnly(text) {
    const s = normalizeSpaces(text);
    const first = (s.split(' ')[0] || '').replace(/^[^A-Za-z\u0E00-\u0E7F]+|[^A-Za-z\u0E00-\u0E7F]+$/g, '');
    return { first, rest: s, titleTh: null, titleEn: null, lang: !first ? 'NONE' : (isThai(first) ? 'TH' : 'EN') };
}

// ============================================================
// Google API Call Functions
// (ถ้าเรียก Google ไม่สำเร็จจะคืน null เสมอ -- ห้ามคืนตัวอักษรไทยเดิมแล้วทำเป็น "ผลแปล")
// ============================================================
function httpGetText(url, timeoutMs = 6000) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { timeout: timeoutMs }, (res) => {
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error('HTTP ' + res.statusCode));
            }
            res.setEncoding('utf8');   // กัน byte ภาษาไทยขาดครึ่งตัวระหว่าง chunk
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data));
            res.on('error', reject);
        });
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', reject);
    });
}

// สถานะการเรียก Google (ดูสาเหตุที่แปลไม่ได้ได้ที่ console และ /health)
const googleStatus = { lastError: null, lastErrorAt: null, lastOkAt: null, blockedUntil: 0, failCount: 0, okCount: 0 };
const GOOGLE_BLOCK_MS = 60 * 1000;   // ล้มเหลวแล้วพักเรียก Google 60 วินาที (กันโดนบล็อกหนักขึ้น + กันรอ timeout ซ้ำ ๆ)
function googleNoteError(e, text) {
    googleStatus.failCount++;
    googleStatus.lastError = String((e && e.message) || e);
    googleStatus.lastErrorAt = new Date().toISOString();
    console.warn(`${C.red}[Google] เรียกไม่สำเร็จ (${googleStatus.lastError}) สำหรับ "${text}" -> ใช้ตัวแปลงออฟไลน์แทนชั่วคราว${C.reset}`);
}
function googleNoteOk() { googleStatus.okCount++; googleStatus.lastOkAt = new Date().toISOString(); googleStatus.blockedUntil = 0; }

const _romanCache = new Map();   // ผลแปลของ Google (โหลดจาก google_name_cache.json ตอนเปิด server)

// ---------- ตั้งค่า server (server_config.json: เปิด/ปิด Google) ----------
const CONFIG_FILE = path.join(__dirname, 'server_config.json');
const GOOGLE_CACHE_FILE = path.join(__dirname, 'google_name_cache.json');
let serverConfig = { useGoogle: true };
let _configMtime = -2;
function loadConfig() {
    try {
        if (!fs.existsSync(CONFIG_FILE)) {
            writeFileAtomic(CONFIG_FILE, JSON.stringify({
                _note: 'useGoogle: true = ใช้ Google ช่วยแปลชื่อ / false = ปิด Google ใช้เฉพาะ name_overrides.txt + ตัวแปลงออฟไลน์ (เร็ว ไม่โดน 429 แต่แม่นน้อยลง) แก้ไฟล์นี้แล้วมีผลทันที',
                useGoogle: true
            }, null, 2), 'utf-8');
        }
        _configMtime = fs.statSync(CONFIG_FILE).mtimeMs;
        const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8').replace(/^\uFEFF/, ''));
        serverConfig = { useGoogle: !(cfg.useGoogle === false || cfg.useGoogle === 0 || String(cfg.useGoogle).toLowerCase() === 'false' || cfg.useGoogle === '0') };
        console.log(`[Config] server_config.json: useGoogle=${serverConfig.useGoogle}`);
    } catch (e) {
        console.error('[Config] อ่าน server_config.json ไม่ได้ (ใช้ค่าเดิม):', e.message);
    }
}
function isGoogleEnabled() {
    if (process.env.USE_GOOGLE === '0' || /^false$/i.test(process.env.USE_GOOGLE || '')) return false;
    try {
        const mt = fs.existsSync(CONFIG_FILE) ? fs.statSync(CONFIG_FILE).mtimeMs : -1;
        if (mt !== _configMtime) loadConfig();
    } catch (e) { /* ใช้ค่าเดิม */ }
    return serverConfig.useGoogle;
}
loadConfig();

// ---------- เก็บผลแปลที่ Google ตอบสำเร็จลงไฟล์ (ชื่อเดิมไม่ต้องถามซ้ำแม้รีสตาร์ท) ----------
try {
    if (fs.existsSync(GOOGLE_CACHE_FILE)) {
        const raw = fs.readFileSync(GOOGLE_CACHE_FILE, 'utf-8').replace(/^\uFEFF/, '');
        if (!raw.trim()) {
            // ไฟล์ว่าง 0 ไบต์ (มักเกิดจากปิดโปรแกรมระหว่างเขียนไฟล์) ไม่ใช่ข้อผิดพลาดร้ายแรง -> เริ่มแคชใหม่ แล้วระบบจะเขียนทับให้เอง
            console.warn('[Cache] google_name_cache.json ว่างเปล่า -> เริ่มแคชใหม่ (ไม่กระทบการทำงาน)');
        } else {
            const saved = JSON.parse(raw);
            for (const [k, v] of Object.entries((saved && saved.th) || {})) if (typeof v === 'string' && v) _romanCache.set(k, v);
            console.log(`[Cache] โหลดผลแปล Google ที่เคยเก็บไว้ ${_romanCache.size} ชื่อ`);
        }
    }
} catch (e) {
    console.error('[Cache] google_name_cache.json เสียหาย (' + e.message + ') -> สำรองไว้ที่ google_name_cache.json.bak แล้วเริ่มแคชใหม่');
    try { fs.copyFileSync(GOOGLE_CACHE_FILE, GOOGLE_CACHE_FILE + '.bak'); } catch (_) { /* สำรองไม่ได้ก็ข้าม */ }
}
let _cacheSaveTimer = null;
let _cacheDirty = false;
function flushGoogleCache() {
    if (_cacheSaveTimer) { clearTimeout(_cacheSaveTimer); _cacheSaveTimer = null; }
    if (!_cacheDirty) return;
    try {
        const th = {};
        for (const [k, v] of _romanCache) th[k] = v;
        writeFileAtomic(GOOGLE_CACHE_FILE, JSON.stringify({ th }, null, 1));
        _cacheDirty = false;
    } catch (e) { console.error('[Cache] เขียน google_name_cache.json ไม่ได้:', e.message); }
}
function scheduleGoogleCacheSave() {
    _cacheDirty = true;
    if (_cacheSaveTimer) return;
    _cacheSaveTimer = setTimeout(() => { _cacheSaveTimer = null; flushGoogleCache(); }, 1500);
}
process.on('exit', flushGoogleCache);   // ปิดโปรแกรมแล้วผลแปลที่ค้างอยู่ในหน่วยความจำต้องไม่หาย

// เว้นระยะระหว่างการเรียก Google (กัน 429 จากการยิงถี่)
const GOOGLE_MIN_GAP_MS = 250;
let _googleChain = Promise.resolve();
function googleThrottle() {
    const p = _googleChain.then(() => new Promise(r => setTimeout(r, GOOGLE_MIN_GAP_MS)));
    _googleChain = p.catch(() => {});
    return p;
}
const _enToThCache = new Map();

async function fetchGoogleRomanization(text) {
    if (!text) return null;
    if (_romanCache.has(text)) return _romanCache.get(text);
    if (!isGoogleEnabled()) return null;                          // ปิด Google ใน server_config.json
    if (Date.now() < googleStatus.blockedUntil) return null;   // กำลังพักเรียก Google
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=th&tl=en&dt=rm&q=${encodeURIComponent(text)}`;
    for (let attempt = 0; attempt < 2; attempt++) {
        await googleThrottle();
        if (Date.now() < googleStatus.blockedUntil) return null;
        try {
            const parsed = JSON.parse(await httpGetText(url, 4000));
            let romanization = "";
            if (parsed && parsed[0]) {
                for (let item of parsed[0]) {
                    if (item && item[2]) romanization += item[2];
                    else if (item && item[3]) romanization += item[3];
                }
            }
            const cleaned = romanization.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
            if (cleaned) {
                googleNoteOk();
                _romanCache.set(text, cleaned);
                scheduleGoogleCacheSave();
                return cleaned;
            }
            // Google ตอบแต่ไม่มี romanization: ถ้าเป็นตัวอังกฤษอยู่แล้วใช้ได้ แต่ถ้าเป็นภาษาไทย = แปลไม่ได้
            if (isThai(text)) { googleNoteError(new Error('Google ตอบกลับแต่ไม่มี romanization'), text); return null; }
            return text.toUpperCase().replace(/[^A-Z0-9]/g, '');
        } catch (e) {
            if (attempt === 1) { googleNoteError(e, text); googleStatus.blockedUntil = Date.now() + GOOGLE_BLOCK_MS; }
        }
    }
    return null;
}

async function fetchGoogleEnToTh(text) {
    if (!text) return null;
    if (_enToThCache.has(text)) return _enToThCache.get(text);
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=th&dt=t&q=${encodeURIComponent(text)}`;
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const parsed = JSON.parse(await httpGetText(url));
            let translated = "";
            if (parsed && parsed[0]) {
                for (let item of parsed[0]) {
                    if (item && item[0]) translated += item[0];
                }
            }
            translated = translated.trim();
            if (isThai(translated)) {
                _enToThCache.set(text, translated);
                return translated;
            }
            return null;   // Google ส่งตัวอังกฤษเดิมกลับมา = ไม่มีคำแปลที่เชื่อถือได้
        } catch (e) { /* ลองอีก 1 ครั้ง */ }
    }
    return null;
}

// ============================================================
// ตัวแปลงเสียงอ่านไทย->อังกฤษแบบออฟไลน์ (ใช้กฎ ไม่ต้องใช้เน็ต) เป็นตัวสำรองเมื่อ Google ใช้ไม่ได้
// ** เป็นค่าประมาณ ไม่แม่นเท่า Google ใช้เพื่อเทียบชื่อแบบ fuzzy เท่านั้น **
// ============================================================
const TH_INIT = {'ก':'K','ข':'KH','ฃ':'KH','ค':'KH','ฅ':'KH','ฆ':'KH','ง':'NG','จ':'CH','ฉ':'CH','ช':'CH','ซ':'S','ฌ':'CH','ญ':'Y','ฎ':'D','ฏ':'T','ฐ':'TH','ฑ':'TH','ฒ':'TH','ณ':'N','ด':'D','ต':'T','ถ':'TH','ท':'TH','ธ':'TH','น':'N','บ':'B','ป':'P','ผ':'PH','ฝ':'F','พ':'PH','ฟ':'F','ภ':'PH','ม':'M','ย':'Y','ร':'R','ล':'L','ว':'W','ศ':'S','ษ':'S','ส':'S','ห':'H','ฬ':'L','อ':'O','ฮ':'H'};
const TH_FINAL = {'ก':'K','ข':'K','ฃ':'K','ค':'K','ฅ':'K','ฆ':'K','ง':'NG','จ':'T','ฉ':'T','ช':'T','ซ':'T','ฌ':'T','ญ':'N','ฎ':'T','ฏ':'T','ฐ':'T','ฑ':'T','ฒ':'T','ณ':'N','ด':'T','ต':'T','ถ':'T','ท':'T','ธ':'T','น':'N','บ':'P','ป':'P','ผ':'P','ฝ':'P','พ':'P','ฟ':'P','ภ':'P','ม':'M','ย':'I','ร':'N','ล':'N','ว':'O','ศ':'T','ษ':'T','ส':'T','ห':'','ฬ':'N','อ':'','ฮ':''};
const TH_VOWEL = {'เ':'E','แ':'AE','โ':'O','ไ':'AI','ใ':'AI','ะ':'A','า':'A','ิ':'I','ี':'I','ึ':'UE','ื':'UE','ุ':'U','ู':'U','ำ':'AM','ั':'A','ฤ':'RUE','ๅ':''};
// สร้างได้ 2 แบบ (สระแฝงเป็น A / O) เพราะภาษาไทยอ่านสระแฝงไม่แน่นอน (ธนภูมิ = THANA… / สมชาย = SOM…) ใช้ทั้งสองแบบเทียบแล้วเอาคะแนนสูงสุด
function romanizeThaiOfflineCore(word, inherent) {
    let s = String(word || '').replace(/เเ/g, 'แ').replace(/[\u0E48-\u0E4B\u0E46\u0E47]/g, '');   // วรรณยุกต์ ไม้ยมก ไม้ไต่คู้
    s = s.replace(/ฤๅ?/g, '{RU}').replace(/ทร(?=[ัาง])/g, 'ส');                                    // ฤ = รึ/ริ ; ทร ที่อ่านเป็น ซ (ทรัพย์ ทราย ทรง)
    s = s.replace(/[ทตศษสคพ]ร\u0E4C/g, '');                                                       // ทร์ ตร์ ศร์ ... ไม่ออกเสียง (อินทร์ จันทร์)
    s = s.replace(/[ก-ฮ][\u0E34-\u0E3A]?\u0E4C/g, '');                                            // ตัวการันต์ (ตัวที่ไม่ออกเสียง)
    // สระผสมที่ต้องจัดการก่อนย้ายสระหน้า
    s = s.replace(/เ([กขคตปพผทบดฟ][รลว])ีย/g, '$1{IA}').replace(/เ([ก-ฮ])ีย/g, '$1{IA}')       // เกียรติ เดี่ยว
         .replace(/เ([ก-ฮ])ือ/g, '$1{UEA}')
         .replace(/เ([ก-ฮ])า/g, '$1{AO}')                                                          // เสา เชา
         .replace(/เ([ก-ฮ])[ิอ]/g, '$1{OE}')                                                       // เกิด เธอ
         .replace(/([ก-ฮ])ัว/g, '$1{UA}');                                                         // บัว ตัว
    s = s.replace(/รร(?=[ก-ฮ]$)/g, '{A}').replace(/รร/g, '{AN}');                                  // รร = อัน (วรรณ ธรรม บรรจง)
    s = s.replace(/([เแโไใ])([ก-ฮ])/g, '$2$1');                                                    // สระหน้า -> ย้ายไปหลังพยัญชนะ
    s = s.replace(/ห([งญนมยรลว])(?=[^ก-ฮ])/g, '$1');                                              // ห นำ (หมาย หนู)
    s = s.replace(/อ(?=[\u0E30-\u0E3A\u0E40-\u0E44])/g, '');                                      // อ นำ (อาทิตย์ อุดม) ไม่ออกเสียง
    s = s.replace(/([ก-ฮ])อ(?=[ก-ฮ]|$)/g, '$1{O}');                                               // อ เป็นสระ ออ (ช้อน พร)
    const isC = (c) => !!c && /[ก-ฮ]/.test(c);
    const CLUSTER_HEAD = 'กขคตปผพทบดฟ';
    let out = '';
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (ch === '{') { const j = s.indexOf('}', i); out += s.slice(i + 1, j); i = j; continue; }
        if (isC(ch)) {
            const next = s[i + 1], next2 = s[i + 2];
            const afterMaiHan = i > 0 && (s[i - 1] === 'ั' || ('ญณ'.includes(ch) && /[\u0E34-\u0E39]/.test(s[i - 1])));   // ั/ิ/ุ + ญ/ณ = ตัวสะกด (อัญ บุญ)
            if (!next) { out += (i === 0 ? TH_INIT[ch] : TH_FINAL[ch]); continue; }       // พยัญชนะท้ายคำ = ตัวสะกด
            if (afterMaiHan && isC(next)) { out += TH_FINAL[ch]; continue; }               // ั + พยัญชนะ = ตัวสะกด (อัญ วัน)
            out += TH_INIT[ch] || '';
            if (isC(next)) {
                if (isC(next2) || !next2) out += inherent;                                  // สระแฝง (สมชาย: ส+โอ+ม)
                else if (!(CLUSTER_HEAD.includes(ch) && 'รลว'.includes(next))) out += 'A';  // พยางค์เปิด (ม+ลิ = มะ-ลิ) ยกเว้นพยัญชนะควบ (ประ กลา)
            }
        } else if (TH_VOWEL[ch] !== undefined) {
            out += TH_VOWEL[ch];
        }
    }
    return out.replace(/[^A-Z]/g, '');
}

function romanizeThaiOfflineVariants(word) {
    const out = [];
    for (const inh of ['O', 'A']) {
        const v = romanizeThaiOfflineCore(word, inh);
        if (v && !out.includes(v)) out.push(v);
    }
    return out;
}

// เวอร์ชันเดิม (คืนแบบเดียว) เพื่อความเข้ากันได้
function romanizeThaiOffline(word) {
    return romanizeThaiOfflineVariants(word)[0] || '';
}

// Google Romanization ของภาษาไทยเป็นการถอดตัวอักษร (ไม่ใช่เสียงอ่าน) มักได้ผลที่ไม่มีสระ เช่น ช้อน -> CHXN, ซ้อน -> SXN
// จึงใช้เมื่อดูสมเหตุสมผลเท่านั้น (ไม่มีตัว X/Q/Z และมีสระพอสมควร)
function isPlausibleRomanization(r) {
    const t = String(r || '').toUpperCase().replace(/[^A-Z]/g, '');
    if (t.length < 2) return false;
    if (/[XQZ]/.test(t)) return false;
    const vowels = (t.match(/[AEIOU]/g) || []).length;
    return vowels / t.length >= 0.25;
}

function findFullNameOverride(name) {
    if (!name) return null;
    const normalized = normalizeSpaces(name);
    for (const [k, v] of Object.entries(NAME_OVERRIDES_TH_TO_EN)) {
        if (normalizeSpaces(k) === normalized) return v;
    }
    return null;
}

function findWordOverride(word) {
    if (!word) return null;
    return NAME_OVERRIDES_TH_TO_EN[word] || null;
}

function enKey(s) {
    return String(s || '').toUpperCase().replace(/[^A-Z]/g, '');
}

// EN -> TH จาก dictionary (name_overrides.txt + DEFAULT_OVERRIDES) -- แหล่งเดียวที่ "เชื่อถือได้" สำหรับ EN->TH
function findReverseDictionaryAll(enText) {
    const key = enKey(enText);
    if (!key) return [];
    const out = [];
    for (const [thName, alts] of Object.entries(NAME_OVERRIDES_ALTS)) {
        if (alts.some(a => enKey(a) === key)) out.push(thName);
    }
    return out;
}

function findReverseDictionary(enText) {
    const all = findReverseDictionaryAll(enText);
    return all.length ? all[0] : null;
}

// TH(ชื่อจริงคำเดียว) -> EN: dictionary ก่อน (รวมทุกการสะกด) แล้วค่อย Google romanization
async function getThaiFirstNameEnglish(firstTh, fullThai) {
    const alts = [];
    const add = (v) => { const u = normalizeSpaces(v).toUpperCase(); if (u && !alts.includes(u)) alts.push(u); };
    (NAME_OVERRIDES_ALTS[firstTh] || []).forEach(add);
    if (!alts.length) { const w = findWordOverride(firstTh); if (w) add(w); }
    if (!alts.length && fullThai) {
        const full = findFullNameOverride(fullThai);
        if (full) add(full.split(' ')[0]);
    }
    if (alts.length) return { variants: alts, engine: 'dictionary', failed: false };

    // รวมทุกแหล่ง: Google (ถ้าใช้ได้และดูสมเหตุสมผล) + ตัวแปลงออฟไลน์ 2 แบบ -> ตอนเทียบจะเอาคะแนนสูงสุด
    const roman = await fetchGoogleRomanization(firstTh);
    const variants = [];
    const googleOk = !!roman && isPlausibleRomanization(roman);
    if (googleOk) variants.push(roman);
    for (const o of romanizeThaiOfflineVariants(firstTh)) if (!variants.includes(o)) variants.push(o);
    if (!variants.length) return { variants: [], engine: 'failed', failed: true };
    return { variants, engine: googleOk ? 'transliteration' : 'offline_rules', failed: false, approximate: !googleOk };
}

async function translateWordsToEnglish(words) {
    const out = [];
    for (const w of words) {
        if (!w) continue;
        if (!isThai(w)) { out.push(w.toUpperCase()); continue; }
        const r = await getThaiFirstNameEnglish(w, '');
        if (r.variants[0]) out.push(r.variants[0]);
    }
    return out.join(' ');
}

// ============================================================
// Core Translation Processor
// - แปล "ชื่อจริงคำแรก" เท่านั้น (ตัดคำนำหน้า + นามสกุลทิ้ง)
// - opts.firstOnly: input เป็นชื่อจริงอยู่แล้ว ไม่ต้องตัดคำนำหน้าซ้ำ
// - opts.full: แถม translated_full (แปลทั้งชื่อเต็มแบบเดิม)
// ============================================================
async function processNameTranslation(name, opts = {}) {
    ensureOverridesFresh();
    const originalInput = normalizeSpaces(name);
    const emptyResult = () => ({ input: originalInput, translated: '', translated_with_title: '', variants: [], engine: 'none', direction: 'NONE', firstName: '' });
    if (!originalInput) return emptyResult();

    const parsed = opts.firstOnly ? parseFirstOnly(originalInput) : extractFirstName(originalInput);
    if (!parsed.first) return emptyResult();
    const { first, rest, titleTh, titleEn } = parsed;

    if (isThai(first)) {
        const r = await getThaiFirstNameEnglish(first, rest);
        const translatedBase = r.variants[0] || '';
        const result = {
            input: originalInput,
            translated: translatedBase,
            translated_with_title: translatedBase ? `${titleEn || 'MR'} ${translatedBase}` : '',
            variants: r.variants,
            engine: r.engine,
            direction: 'TH_TO_EN',
            firstName: first,
            title_en: titleEn,
            title_th: titleTh,
            failed: r.failed
        };
        if (r.approximate) result.approximate = true;
        if (r.failed) result.error = 'romanization_unavailable';
        if (opts.full) result.translated_full = await translateWordsToEnglish(rest.split(' '));
        return result;
    } else {
        const dictHits = findReverseDictionaryAll(first);
        let variants = [];
        let engine = 'google_translate';
        let reliable = false;
        if (dictHits.length) {
            variants = dictHits;
            engine = 'dictionary';
            reliable = true;
        } else if (!opts.dictionaryOnly) {
            const g = await fetchGoogleEnToTh(first);
            if (g) variants = [g];
        }
        const translatedThai = variants[0] || '';
        const result = {
            input: originalInput,
            translated: translatedThai,
            translated_with_title: translatedThai ? `${titleTh || 'นาย'}${translatedThai}` : '',
            variants,
            engine,
            direction: 'EN_TO_TH',
            firstName: first,
            romanized: first.toUpperCase(),
            reliable,
            title_en: titleEn,
            title_th: titleTh,
            failed: !translatedThai
        };
        if (!translatedThai) result.error = 'no_reliable_translation';
        return result;
    }
}

// ============================================================
// Fuzzy String Matching (Rapidfuzz Equivalent for /match)
// ============================================================
function levenshtein(a, b) {
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;
    const matrix = [];
    for (let i = 0; i <= b.length; i++) matrix[i] = [i];
    for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
    for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
            if (b.charAt(i - 1) === a.charAt(j - 1)) {
                matrix[i][j] = matrix[i - 1][j - 1];
            } else {
                matrix[i][j] = Math.min(matrix[i - 1][j - 1] + 1, Math.min(matrix[i][j - 1] + 1, matrix[i - 1][j] + 1));
            }
        }
    }
    return matrix[b.length][a.length];
}

function similarityPercent(s1, s2) {
    const clean1 = String(s1 || '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
    const clean2 = String(s2 || '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
    if (!clean1 && !clean2) return 100.0;
    if (!clean1 || !clean2) return 0.0;
    const maxLen = Math.max(clean1.length, clean2.length);
    const dist = levenshtein(clean1, clean2);
    return Number(((1 - dist / maxLen) * 100).toFixed(2));
}

function tokenSortRatio(s1, s2) {
    const t1 = String(s1 || '').toUpperCase().split(/\s+/).filter(Boolean).sort().join(' ');
    const t2 = String(s2 || '').toUpperCase().split(/\s+/).filter(Boolean).sort().join(' ');
    return similarityPercent(t1, t2);
}

// ============================================================
// First-name similarity (ใช้เฉพาะชื่อจริงคำแรกหลังตัดคำนำหน้า/นามสกุล)
// ============================================================
const NAME_MATCH_DEFAULT_THRESHOLD = 50;   // เกณฑ์ชื่อจริงคำแรก 50%
const NAME_MATCH_SHORT_LEN = 4;            // ชื่อสั้นใช้เกณฑ์เดียวกัน
const NAME_MATCH_SHORT_THRESHOLD = 50;
const NAME_REVIEW_PERCENT = 70;            // ชื่อข้ามภาษาที่ "ผ่าน" แต่ความเหมือนต่ำกว่า 70% -> บันทึกลง unmatched_names.txt ให้ตรวจ

// รวมการสะกดอังกฤษที่ต่างกันตามระบบถอดเสียง (PH=P, TH=T, KH=K, CH=J, W=V, ตัวซ้ำ ฯลฯ)
function canonicalizeEnName(s) {
    let t = String(s || '').toUpperCase().replace(/[^A-Z]/g, '');
    t = t.replace(/PH/g, 'P').replace(/TH/g, 'T').replace(/KH/g, 'K').replace(/GH/g, 'G')
         .replace(/CH/g, 'J').replace(/OO/g, 'U').replace(/EE/g, 'I').replace(/AA/g, 'A')
         .replace(/[CQ]/g, 'K').replace(/Y/g, 'I').replace(/V/g, 'W').replace(/H/g, '')
         .replace(/RN/g, 'N').replace(/L$/, 'N').replace(/(.)\1+/g, '$1');
    return t;
}

// ตัวอักษรแรกของชื่อต้อง "สอดคล้องกัน" (กลุ่มเสียงใกล้กัน) ไม่งั้นถือว่าคนละชื่อ -- ลดการจับคู่ผิดจากชื่อที่เสียงคล้ายแค่ตรงกลาง/ท้ายคำ
const FIRST_LETTER_GROUPS = ['TD', 'BP', 'KG', 'LR', 'WV', 'AEIOU'];
function firstLettersCompatible(canonA, canonB) {
    const x = canonA[0], y = canonB[0];
    if (!x || !y) return false;
    if (x === y) return true;
    return FIRST_LETTER_GROUPS.some(g => g.includes(x) && g.includes(y));
}

function enNameSimilarity(a, b) {
    const ra = String(a || '').toUpperCase().replace(/[^A-Z]/g, '');
    const rb = String(b || '').toUpperCase().replace(/[^A-Z]/g, '');
    if (!ra || !rb) return 0;
    const raw = (1 - levenshtein(ra, rb) / Math.max(ra.length, rb.length)) * 100;
    const ca = canonicalizeEnName(ra), cb = canonicalizeEnName(rb);
    const canon = (ca && cb) ? (1 - levenshtein(ca, cb) / Math.max(ca.length, cb.length)) * 100 : 0;
    let score = Math.max(raw, canon);
    // ชื่อจริง+นามสกุลที่เขียนติดกัน (เช่น สนองขุนทอง): ถ้าชื่อสั้นเป็น "ส่วนหน้า" ของชื่อยาวและยาวตั้งแต่ 5 ตัวอักษร ถือว่าใกล้เคียงมาก
    if (ca && cb) {
        const [shortC, longC] = ca.length <= cb.length ? [ca, cb] : [cb, ca];
        if (shortC.length >= 5 && shortC.length < longC.length && longC.startsWith(shortC)) score = Math.max(score, 75);
    }
    if (!firstLettersCompatible(ca || ra, cb || rb)) return Math.min(score, 49);
    return score;
}

function normalizeThaiName(s) {
    return String(s || '')
        .replace(/เเ/g, 'แ')                    // พิมพ์ เ สองตัวแทน แ
        .replace(/[\u0E48-\u0E4C\u0E46]/g, '')   // วรรณยุกต์ ทัณฑฆาต ไม้ยมก
        .replace(/[^\u0E00-\u0E7F]/g, '');
}

function thaiNameSimilarity(a, b) {
    const ta = normalizeThaiName(a), tb = normalizeThaiName(b);
    if (!ta || !tb) return 0;
    return (1 - levenshtein(ta, tb) / Math.max(ta.length, tb.length)) * 100;
}

// ชื่อ 2 ฝั่งเป็นการสะกดใน dictionary ของ "ชื่อไทยคนละชื่อ" (เช่น SOMCHAI=สมชาย vs SOMMAI=สมหมาย) -> คนละชื่อแน่นอน
// ไม่ว่าคะแนนความเหมือนจะสูงแค่ไหน
function isKnownDifferentNames(thSetA, thSetB) {
    if (!thSetA.length || !thSetB.length) return false;
    const na = thSetA.map(normalizeThaiName), nb = thSetB.map(normalizeThaiName);
    return !na.some(x => nb.includes(x));
}

// ============================================================
// บันทึกชื่อที่ต้องให้คนตรวจลง unmatched_names.txt  รูปแบบ:  ชื่อไทย = ชื่ออังกฤษจากสลิป
//   1) แปล/จับคู่ข้ามภาษาไม่สำเร็จ   2) จับคู่ผ่าน แต่ความเหมือนต่ำกว่า NAME_REVIEW_PERCENT (70%)
// -> ก๊อปบรรทัดไปวางใน name_overrides.txt ได้เลย
// ไม่บันทึกซ้ำ: ชื่อคู่เดิมที่มีในไฟล์นี้แล้ว หรือมีใน name_overrides.txt อยู่แล้ว (ไฟล์มีแต่บรรทัด "ชื่อไทย = ชื่ออังกฤษ" ล้วน ๆ ไม่ใส่หมายเหตุ)
// note ใช้แสดงใน console เท่านั้น (ไม่เขียนลงไฟล์ เพื่อให้ก๊อปไปวางต่อได้ทันที)
// ============================================================
const UNMATCHED_FILE = path.join(__dirname, 'unmatched_names.txt');
const EN_TITLE_WORD_RE = /^(MR|MRS|MS|MISS|MASTER|MSTR|DR|PROF|KHUN)$/;
function recordUnmatchedName(thFirst, enFirst, note) {
    try {
        const th = normalizeSpaces(thFirst);
        const en = String(enFirst || '').toUpperCase().replace(/[^A-Z\-'. ]/g, '').replace(/\s+/g, ' ').trim();
        const enLetters = enKey(en);
        if (!/^[\u0E00-\u0E7F]{2,}$/.test(th) || enLetters.length < 2 || EN_TITLE_WORD_RE.test(enLetters)) {
            return { recorded: false, reason: 'invalid_name' };
        }
        if ((NAME_OVERRIDES_ALTS[th] || []).some(a => enKey(a) === enLetters)) {
            return { recorded: false, reason: 'already_in_name_overrides' };
        }
        let existing = '';
        if (fs.existsSync(UNMATCHED_FILE)) existing = fs.readFileSync(UNMATCHED_FILE, 'utf-8').replace(/^\uFEFF/, '');
        for (const l of existing.split(/\r?\n/)) {
            const i = l.indexOf('=');
            if (i <= 0) continue;
            if (normalizeSpaces(l.slice(0, i)) === th && enKey(l.slice(i + 1)) === enLetters) {
                return { recorded: false, reason: 'duplicate' };
            }
        }
        const eol = existing.includes('\r\n') ? '\r\n' : '\n';
        const line = `${th} = ${en}`;
        fs.appendFileSync(UNMATCHED_FILE, (existing && !/\n$/.test(existing) ? eol : '') + line + eol, 'utf-8');
        const noteTxt = note ? ` (${String(note).replace(/[\r\n]+/g, ' ').slice(0, 80)})` : '';
        console.log(`[Unmatched] บันทึกลง unmatched_names.txt: ${line}${noteTxt}`);
        return { recorded: true, line };
    } catch (e) {
        return { recorded: false, reason: 'error: ' + e.message };
    }
}

function logMiss(orderTh, slipEn, result) {
    try {
        const reasonTh = {
            'No first name to compare after removing titles': 'ไม่พบชื่อจริงให้เทียบหลังตัดคำนำหน้า',
            'Translation unavailable (cannot romanize Thai name, no dictionary entry)': 'แปลชื่อไม่ได้ (ไม่มีใน name_overrides และ Google/ตัวออฟไลน์ใช้ไม่ได้)',
            'Different known names (dictionary)': 'dictionary ยืนยันว่าเป็นคนละชื่อ',
            'Score below threshold': 'ความเหมือนต่ำกว่าเกณฑ์',
            'Matched successfully': 'ตรงกัน'
        };
        const trustTh = { HIGH: 'สูง', MEDIUM: 'ปานกลาง', LOW: 'ต่ำ' };
        const dirTh = { TH_TO_EN: 'ไทย→อังกฤษ', EN_TO_TH: 'อังกฤษ→ไทย', TH_TO_TH: 'ไทย-ไทย', EN_TO_EN: 'อังกฤษ-อังกฤษ', NONE: '-' };
        const time = new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', hour12: false });
        const cands = (result.candidates || []).join(' / ') || '-';
        const row = `[${time}] ไม่ผ่าน | ชื่อใน Order: "${orderTh}" | ชื่อในสลิป: "${slipEn}"`
            + ` | ชื่อจริงที่เทียบ: "${result.orderFirst || '-'}" กับ "${result.slipFirst || '-'}" (${dirTh[result.direction] || '-'})`
            + ` | ความเหมือน ${result.percent}% (เกณฑ์ ${result.threshold}%) | ความน่าเชื่อถือ: ${trustTh[result.trust] || '-'}`
            + ` | ผลแปลที่ดีที่สุด: ${result.translated || '-'} | ตัวเลือกที่เทียบ: ${cands}`
            + ` | สาเหตุ: ${reasonTh[result.reason] || result.reason || '-'}`;
        fs.appendFileSync(MISS_LOG_FILE, row + '\n', 'utf-8');
    } catch (e) {}
}

// จับคู่ชื่อ 2 ฝั่ง (ไทย/อังกฤษ ฝั่งไหนก็ได้) โดยเทียบเฉพาะชื่อจริงคำแรก
//  - ไทย-ไทย / อังกฤษ-อังกฤษ : เทียบตรง ๆ ไม่แปล
//  - ไทย<->อังกฤษ           : แปลฝั่งไทยเป็นอังกฤษ (dictionary -> Google) แล้วเทียบ
//                              + เช็ค EN->TH จาก dictionary เทียบกับชื่อไทยอีกทาง
async function matchNamesLogic(orderName, slipName, threshold = NAME_MATCH_DEFAULT_THRESHOLD) {
    ensureOverridesFresh();
    const a = extractFirstName(orderName);
    const b = extractFirstName(slipName);
    const baseThr = (Number.isFinite(Number(threshold)) && Number(threshold) > 0) ? Number(threshold) : NAME_MATCH_DEFAULT_THRESHOLD;

    const result = {
        isMatch: false, percent: 0, trust: 'LOW', threshold: baseThr,
        translated: '', candidates: [], reason: '', direction: 'NONE',
        orderFirst: a.first, slipFirst: b.first, failed: false
    };

    if (!a.first || !b.first) {
        result.reason = 'No first name to compare after removing titles';
        logMiss(orderName, slipName, result);
        return result;
    }

    let score = 0;
    let best = '';
    let cands = [];
    let compareLen = 0;
    let pairForReport = null;   // [ชื่อไทย, ชื่ออังกฤษ] เมื่อเทียบข้ามภาษา และ "ไม่ผ่าน" จะรายงาน (ไม่รวมกรณี dictionary ยืนยันแล้ว)
    let pairForReview = null;   // [ชื่อไทย, ชื่ออังกฤษ] เมื่อเทียบข้ามภาษา -- ใช้รายงานกรณี "ผ่านแต่ความเหมือนต่ำกว่า 70%"

    if (a.lang === 'TH' && b.lang === 'TH') {
        result.direction = 'TH_TO_TH';
        score = thaiNameSimilarity(a.first, b.first);
        // ทั้งสองชื่ออยู่ใน dictionary แต่เป็นคนละชื่อ (เช่น สมชาย vs สมหมาย) -> คนละคน
        const altsA = NAME_OVERRIDES_ALTS[a.first], altsB = NAME_OVERRIDES_ALTS[b.first];
        if (altsA && altsB && normalizeThaiName(a.first) !== normalizeThaiName(b.first) &&
            !altsA.some(x => altsB.some(y => enKey(x) === enKey(y)))) {
            result.reason = 'Different known names (dictionary)';
            score = 0;
        }
        best = b.first;
        cands = [a.first, b.first];
        compareLen = Math.min(normalizeThaiName(a.first).length, normalizeThaiName(b.first).length) + 1; // ชื่อไทย 3 ตัวอักษร ~ สั้นเทียบ 4
    } else if (a.lang === 'EN' && b.lang === 'EN') {
        result.direction = 'EN_TO_EN';
        score = enNameSimilarity(a.first, b.first);
        if (isKnownDifferentNames(findReverseDictionaryAll(a.first), findReverseDictionaryAll(b.first))) {
            result.reason = 'Different known names (dictionary)';
            score = 0;
        }
        best = a.first.toUpperCase();
        cands = [a.first.toUpperCase(), b.first.toUpperCase()];
        compareLen = Math.min(enKey(a.first).length, enKey(b.first).length);
    } else {
        const thaiSide = a.lang === 'TH' ? a : b;
        const enSide = a.lang === 'TH' ? b : a;
        result.direction = a.lang === 'TH' ? 'TH_TO_EN' : 'EN_TO_TH';
        pairForReport = [thaiSide.first, enSide.first];
        pairForReview = [thaiSide.first, enSide.first];

        const tr = await getThaiFirstNameEnglish(thaiSide.first, thaiSide.rest);
        result.failed = tr.failed;
        // แปลจาก dictionary (ยืนยันแล้ว) แต่ไม่ตรง = เป็นคนละคน ไม่ใช่ "แปลไม่สำเร็จ" -> ไม่ต้องรายงาน
        if (tr.engine === 'dictionary') pairForReport = null;
        cands = [...tr.variants];
        for (const v of tr.variants) {
            const s = enNameSimilarity(v, enSide.first);
            if (s > score) { score = s; best = v; compareLen = Math.min(enKey(v).length, enKey(enSide.first).length); }
        }
        // EN -> TH (เฉพาะ dictionary ที่เชื่อถือได้ ไม่เอาผลแปลของ Google มาเดา)
        for (const h of findReverseDictionaryAll(enSide.first)) {
            const s = thaiNameSimilarity(h, thaiSide.first);
            cands.push(h);
            if (s > score) { score = s; best = h; compareLen = Math.min(normalizeThaiName(h).length, normalizeThaiName(thaiSide.first).length) + 1; }
        }
        if (!cands.length) result.reason = 'Translation unavailable (cannot romanize Thai name, no dictionary entry)';
        // ชื่อไทยอยู่ใน dictionary และชื่ออังกฤษเป็นการสะกดของ "ชื่อไทยอีกชื่อหนึ่ง" -> คนละชื่อ
        if (tr.engine === 'dictionary' && isKnownDifferentNames([thaiSide.first], findReverseDictionaryAll(enSide.first))) {
            result.reason = 'Different known names (dictionary)';
            score = 0;
        }
    }

    const effThr = (compareLen > 0 && compareLen <= NAME_MATCH_SHORT_LEN) ? Math.max(baseThr, NAME_MATCH_SHORT_THRESHOLD) : baseThr;
    const percent = Number(score.toFixed(2));
    result.percent = percent;
    result.threshold = effThr;
    result.translated = best;
    result.candidates = cands;
    result.isMatch = percent > 0 && percent >= effThr;
    result.trust = percent >= 90 ? 'HIGH' : (percent >= 75 ? 'MEDIUM' : 'LOW');
    if (!result.reason) result.reason = result.isMatch ? 'Matched successfully' : 'Score below threshold';

    if (!result.isMatch) {
        logMiss(orderName, slipName, result);
        // ข้ามภาษาแล้วไม่ผ่าน (ไม่นับกรณี dictionary ยืนยันว่าเป็นคนละชื่อ) -> เก็บไว้ให้ผู้ใช้ตรวจแล้วเพิ่มเข้า name_overrides.txt
        if (pairForReport && !/Different known names/.test(result.reason)) recordUnmatchedName(pairForReport[0], pairForReport[1], `ไม่ผ่าน ${percent}%`);
    } else if (pairForReview && percent < NAME_REVIEW_PERCENT) {
        // ผ่านแต่คะแนนยังต่ำกว่า 70% -> เก็บไว้ให้ผู้ใช้ตรวจแล้วเพิ่มสะกดที่ถูกต้องเข้า name_overrides.txt
        // (สะกดตรง dictionary 100% / ซ้ำกับที่บันทึกไว้แล้ว / มีใน name_overrides.txt อยู่แล้ว จะถูกข้ามใน recordUnmatchedName)
        recordUnmatchedName(pairForReview[0], pairForReview[1], `ผ่านแต่ ${percent}% ต่ำกว่า ${NAME_REVIEW_PERCENT}%`);
    }
    return result;
}

// ============================================================
// Claim & Release System (Cross-profile with TTL)
// ============================================================
const _claims = {};
const CLAIM_TTL_SECONDS = 2 * 60; // 2 minutes

function cleanupExpiredClaims() {
    const now = Date.now() / 1000;
    for (const [k, ts] of Object.entries(_claims)) {
        if (now - ts > CLAIM_TTL_SECONDS) {
            delete _claims[k];
        }
    }
}

// ============================================================
// Express Endpoints
// ============================================================
// รวมคำขอแปลชื่อเดียวกันที่เข้ามาพร้อมกันให้ใช้ Promise เดียว ลดการยิง Google ซ้ำ
// ไม่เก็บผลล้มเหลวลง cache: รอบถัดไปยังลองใหม่ได้ตามพฤติกรรมเดิม
const _translationInFlight = new Map();
function processNameTranslationDeduped(name, opts) {
    const key = JSON.stringify([normalizeSpaces(name), opts || {}]);
    if (_translationInFlight.has(key)) return _translationInFlight.get(key);
    const pending = processNameTranslation(name, opts)
        .finally(() => _translationInFlight.delete(key));
    _translationInFlight.set(key, pending);
    return pending;
}
app.get('/translate', async (req, res) => {
    const start = Date.now();
    const name = req.query.name || req.query.text || '';
    try {
        const result = await processNameTranslationDeduped(name, {
            firstOnly: req.query.firstOnly === '1',
            full: req.query.full === '1',
            dictionaryOnly: req.query.dictionaryOnly === '1'
        });
        logSleekRequest('GET', '/translate', 200, result, Date.now() - start);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/translate', async (req, res) => {
    const start = Date.now();
    const name = req.body?.name || req.body?.text || '';
    try {
        const result = await processNameTranslationDeduped(name, {
            firstOnly: req.body?.firstOnly === '1' || req.body?.firstOnly === true,
            full: req.body?.full === '1' || req.body?.full === true,
            dictionaryOnly: req.body?.dictionaryOnly === '1' || req.body?.dictionaryOnly === true
        });
        logSleekRequest('POST', '/translate', 200, result, Date.now() - start);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Userscript ส่งรายการเทียบชื่อที่ "ไม่ผ่าน" มาบันทึกลง translate_misses.log (ภาษาไทย) -- Userscript เทียบชื่อเอง ไม่ได้เรียก /match
const _recentMisses = new Map();
app.get('/log-miss', (req, res) => {
    try {
        const q = req.query;
        const key = `${q.order || ''}|${q.slip || ''}`;
        const now = Date.now();
        if (_recentMisses.has(key) && now - _recentMisses.get(key) < 10 * 60 * 1000) return res.json({ logged: false, reason: 'duplicate_recent' });
        _recentMisses.set(key, now);
        if (_recentMisses.size > 2000) _recentMisses.clear();
        const reasonMap = {
            below_threshold: 'Score below threshold',
            no_first_name: 'No first name to compare after removing titles',
            known_different: 'Different known names (dictionary)',
            translation_unavailable: 'Translation unavailable (cannot romanize Thai name, no dictionary entry)'
        };
        const percent = Number(q.percent) || 0;
        logMiss(q.order || '', q.slip || '', {
            percent,
            threshold: Number(q.threshold) || NAME_MATCH_DEFAULT_THRESHOLD,
            trust: percent >= 90 ? 'HIGH' : (percent >= 75 ? 'MEDIUM' : 'LOW'),
            translated: q.translated || '',
            candidates: q.candidates ? String(q.candidates).split('|').filter(Boolean) : [],
            reason: reasonMap[q.reason] || q.reason || '',
            orderFirst: q.orderFirst || '',
            slipFirst: q.slipFirst || '',
            direction: q.direction || 'NONE'
        });
        res.json({ logged: true });
    } catch (e) {
        res.json({ logged: false, reason: 'error: ' + e.message });
    }
});

app.get('/unmatched', (req, res) => {
    res.json(recordUnmatchedName(req.query.th || '', req.query.en || '', req.query.note || ''));
});

app.get('/match', async (req, res) => {
    const start = Date.now();
    const orderTh = req.query.name || '';
    const slipEn = req.query.slip || '';
    const threshold = req.query.threshold || NAME_MATCH_DEFAULT_THRESHOLD;
    try {
        const result = await matchNamesLogic(orderTh, slipEn, threshold);
        logSleekRequest('GET', '/match', 200, { input: orderTh, translated: slipEn, ...result }, Date.now() - start);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/engines', (req, res) => {
    res.json({
        google_romanize: { available: true, engine: "google_api" },
        google_translate: { available: true, engine: "google_api" },
        dictionary: { available: true, count: Object.keys(NAME_OVERRIDES_TH_TO_EN).length, spellings: Object.values(NAME_OVERRIDES_ALTS).reduce((n, a) => n + a.length, 0) }
    });
});

app.get('/claim', (req, res) => {
    const orderNo = (req.query.orderNo || '').trim();
    if (!orderNo) {
        return res.json({ claimed: true, orderNo: '', reason: 'no orderNo provided' });
    }
    cleanupExpiredClaims();
    const now = Date.now() / 1000;
    const existing = _claims[orderNo];
    if (existing !== undefined && (now - existing) <= CLAIM_TTL_SECONDS) {
        return res.json({ claimed: false, orderNo });
    }
    _claims[orderNo] = now;
    return res.json({ claimed: true, orderNo });
});

app.all('/release', (req, res) => {
    const orderNo = (req.query.orderNo || req.body?.orderNo || '').trim();
    if (orderNo) {
        delete _claims[orderNo];
    }
    res.json({ released: true, orderNo });
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'Node.js Python-Compatible Transliteration & Claim API', version: '4.3.0', reviewBelowPercent: NAME_REVIEW_PERCENT, overrideWarnings, google: { ...googleStatus, enabled: isGoogleEnabled(), cachedNames: _romanCache.size, blocked: Date.now() < googleStatus.blockedUntil } });
});

app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint not found' });
});

// กัน request ที่ผิดรูปแบบ (เช่น JSON พัง) ทำให้ตอบกลับเป็นหน้า HTML/ค้าง -> ตอบ JSON เสมอ
app.use((err, req, res, next) => {
    console.error('[Express] error:', err && err.message);
    if (res.headersSent) return next(err);
    res.status((err && (err.status || err.statusCode)) || 500).json({ error: (err && err.message) || 'internal_error' });
});

// ============================================================
// Server Initialization
// ============================================================
function startServer() {
// กัน server ล้มทั้งตัวจาก error ที่ไม่ได้ดักไว้ (บอทจะได้ไม่เสียการเชื่อมต่อกลางงาน) -- บันทึกไว้แล้วทำงานต่อ
process.on('uncaughtException', (e) => console.error(`${C.red}[Fatal-guard] uncaughtException:${C.reset}`, e && e.stack || e));
process.on('unhandledRejection', (e) => console.error(`${C.red}[Fatal-guard] unhandledRejection:${C.reset}`, e && e.stack || e));
// ปิดด้วย Ctrl+C / ปิดหน้าต่าง -> เซฟแคชที่ค้างอยู่ก่อนออก
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { flushGoogleCache(); process.exit(0); });

const server = app.listen(PORT, HOST, () => {
    const startupNotes = [
        `[Overrides] ${Object.keys(NAME_OVERRIDES_TH_TO_EN).length} ชื่อ${overrideWarnings.length ? ` (มีคำเตือน ${overrideWarnings.length} รายการ)` : ''}`,
        `[Cache] ผลแปล Google ที่เก็บไว้ ${_romanCache.size} ชื่อ`,
        `[Google] ${isGoogleEnabled() ? 'เปิดใช้งาน' : 'ปิด (ใช้ name_overrides.txt + ตัวแปลงออฟไลน์)'}`,
        `[Unmatched] บันทึกชื่อที่แปลไม่ได้ + ผ่านแต่ต่ำกว่า ${NAME_REVIEW_PERCENT}% -> unmatched_names.txt (ชื่อซ้ำไม่ลงซ้ำ)`
    ];
    console.clear();
    console.log(`${C.cyan}${C.bold}`);
    console.log(` ╔══════════════════════════════════════════════════════════════════╗`);
    console.log(` ║   ⚡ NODE.JS PYTHON-COMPATIBLE API SERVER v4.0 (AUTO BOT)        ║`);
    console.log(` ╚══════════════════════════════════════════════════════════════════╝${C.reset}`);
    console.log(``);
    console.log(`  ${C.bgGreen} STATUS ${C.reset}  ${C.green}${C.bold}ONLINE${C.reset} running at ${C.cyan}${C.underline}http://${HOST}:${PORT}${C.reset}`);
    console.log(`  ${C.bgMagenta} FEATURES${C.reset} /translate, /match, /claim, /release, /engines, Overrides`);
    console.log(``);
    console.log(` ${C.gray} ─`.repeat(33) + `${C.reset}`);
    console.log(`  ${C.bold}Available Endpoints:${C.reset}`);
    console.log(`   ${C.gray}├─${C.reset} ${C.blue}GET ${C.reset}  ${C.white}http://${HOST}:${PORT}/translate?name=นายมนต์นที%20พัดวัง${C.reset}`);
    console.log(`   ${C.gray}├─${C.reset} ${C.blue}GET ${C.reset}  ${C.white}http://${HOST}:${PORT}/match?name=มนต์นที&slip=MONNATEE&threshold=50${C.reset}`);
    console.log(`   ${C.gray}├─${C.reset} ${C.blue}GET ${C.reset}  ${C.white}http://${HOST}:${PORT}/claim?orderNo=12345${C.reset}`);
    console.log(`   ${C.gray}└─${C.reset} ${C.yellow}GET ${C.reset}  ${C.white}http://${HOST}:${PORT}/health${C.reset}`);
    console.log(` ${C.gray} ─`.repeat(33) + `${C.reset}`);
    console.log(`\n  ${C.gray}สถานะตอนเปิด:${C.reset}`);
    for (const n of startupNotes) console.log(`   ${C.gray}•${C.reset} ${n}`);
    for (const w of overrideWarnings) console.log(`   ${C.yellow}⚠️  ${w}${C.reset}`);
    console.log(`\n  ${C.yellow}${C.bold}Waiting for incoming requests...${C.reset}\n`);
});
server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
        console.error(`\n${C.red}${C.bold}[ERROR] พอร์ต ${PORT} ถูกใช้งานอยู่แล้ว${C.reset} (น่าจะเปิด server ค้างไว้อีกหน้าต่างหนึ่ง) -> ปิดหน้าต่างเดิมก่อนแล้วเปิดใหม่`);
        process.exit(2);
    }
    console.error(`${C.red}[ERROR] เปิด server ไม่สำเร็จ:${C.reset}`, err && err.message);
    process.exit(1);
});
}

if (require.main === module) startServer();

module.exports = {
    app, startServer, processNameTranslation, matchNamesLogic, extractTitle, extractFirstName, stripNameTitles,
    validateOverrides, isPlausibleRomanization, recordUnmatchedName, isGoogleEnabled, romanizeThaiOffline, romanizeThaiOfflineVariants, canonicalizeEnName, enNameSimilarity, thaiNameSimilarity, normalizeThaiName, loadOverrides,
    findReverseDictionaryAll, getThaiFirstNameEnglish,
    writeFileAtomic, flushGoogleCache, scheduleGoogleCacheSave, _romanCache, NAME_REVIEW_PERCENT
};

