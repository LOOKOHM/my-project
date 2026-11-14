// ==UserScript==
// @name         Auto Slip Claim ฉบับพรีเมี่ยม🤖
// @namespace    http://tampermonkey.net/
// @version      5.5
// @description  ระบบตรวจสลิปอัตโนมัติ (Console Log ละเอียดเรื่องการเทียบชื่อและเลขบัญชี + Bank Map Alignment)
// @author       Gemini
// @match        https://manage.monopay168.cloud/*
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @connect      localhost
// ==/UserScript==

(function() {
    'use strict';

    let isRunning = false;
    let queue = [];
    let isProcessing = false;
    let consecutiveUnreadableChecks = 0;
    const MAX_CONSECUTIVE_UNREADABLE = 3;

    // --- สำหรับรีเฟรชหน้าอัตโนมัติเมื่อคิวว่างต่อเนื่อง ---
    let emptyScanStreak = 0;
    let isRefreshScheduled = false;
    const REFRESH_AFTER_EMPTY_SCANS = 2;
    const REFRESH_DELAY_MS = 10000;

    const RUNNING_STATE_KEY = 'autoApproveBot_isRunning_v2';

    // --- Console Styling Helpers ---
    const cLog = {
        info: (msg) => console.log(`%c ℹ️ [INFO] ${msg}`, 'color: #040057; background: #ffffff; padding: 2px 6px; border-radius: 4px; font-weight: bold;'),
        success: (msg) => console.log(`%c ✅ [SUCCESS] ${msg}`, 'color: #3aebaa; font-weight: bold;'),
        warn: (msg) => console.log(`%c ⚠️ [WARN] ${msg}`, 'color: #ffac12; font-weight: bold;'),
        error: (msg) => console.log(`%c ❌ [ERROR] ${msg}`, 'color: #f87171; font-weight: bold;'),
        yellow: (msg) => console.log(`%c 🟡 [QUEUE] ${msg}`, 'color: #f9f236; font-weight: bold;'),
        step: (msg) => console.log('%c 🔍 [STEP]%c ' + msg, 'color: #e9d3ff; font-weight: bold;', 'color: #b76eff; font-weight: bold;'),
        bot: (msg) => console.log(`%c 🤖 [BOT] ${msg}`, 'color: #38bdf8; background: #03002e; padding: 2px 6px; border-radius: 4px; font-weight: bold;'),
        group: (title) => console.groupCollapsed(`%c 📂 [ORDER] ${title}`, 'color: #ffffff; font-weight: bold; background: #5e6471; padding: 2px 6px; border-radius: 4px; font-weight: bold;'),
        groupEnd: () => console.groupEnd()
    };

    // ============================================================
    // ตั้งค่าเปิด/ปิดแต่ละฟังก์ชันการทำงาน (persist ข้าม reload)
    // ============================================================
    const SETTINGS_KEY = 'autoApproveBot_settings_v1';
    const DEFAULT_SETTINGS = {
        enableAmountTolerance: true,          // เปิด/ปิด การผ่อนปรนยอดเงิน ±1.99 บาท
        enableSenderAccountCheck: true,       // เปิด/ปิด เคสพิเศษ: ชื่อบัญชีผู้โอนไม่ตรง แต่เลขบัญชีเรียงตรงกัน -> อนุมัติ
        enableRejectAmountMismatch: true,     // เปิด/ปิด การปฏิเสธรายการที่ "ยอดเงินไม่ตรง" ทุกกรณี
        enableSenderNameFuzzyCheck: true,     // เปิด/ปิด เช็คชื่อผู้โอนแบบแปลไทย->อังกฤษ+fuzzy match (เฉพาะ ธ.กรุงเทพ/กรุงศรี)
        enableReceiverNameCustomCheck: true,  // เปิด/ปิด: ชื่อบัญชีผู้รับที่กำหนดเอง
        enableCustomLast4Override: true,      // เปิด/ปิด: last4 กำหนดเอง
        enableSenderNameFuzzyCheckGeneral: true, // เปิด/ปิด: เช็คชื่อผู้โอน fuzzy ทั่วไป (ทุกธนาคาร)
        enableAutoReOcr: false,               // เปิด/ปิด: Auto กดปุ่ม re-OCR อัตโนมัติเมื่อพบรายการ "OCR ล้มเหลว"
        enableUniformBankMap: false,          // เปิด/ปิด: ใช้กฎเช็คเลขบัญชีแบบสากล (Dynamic Length-Based Bank Map)
        enableUobNameBypass: true,            // เปิด/ปิด: UOB (TMRW) ชื่อผู้โอนบนสลิปเป็น "TMRW" เสมอ -> ข้ามการเทียบชื่อ ใช้เลขบัญชีอย่างเดียว
    };

    function loadSettings() {
        try {
            const raw = localStorage.getItem(SETTINGS_KEY);
            if (!raw) return { ...DEFAULT_SETTINGS };
            return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
        } catch (e) {
            cLog.warn('อ่านการตั้งค่าฟังก์ชันจาก localStorage ไม่สำเร็จ ใช้ค่าเริ่มต้นแทน: ' + e);
            return { ...DEFAULT_SETTINGS };
        }
    }

    function saveSettings() {
        try {
            localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
        } catch (e) {
            cLog.warn('บันทึกการตั้งค่าฟังก์ชันลง localStorage ไม่สำเร็จ: ' + e);
        }
    }

    let settings = loadSettings();

    // --- รายชื่อฟังก์ชันที่เปิด/ปิดได้ผ่าน UI ---
    const SETTINGS_FIELDS = [
        { key: 'enableAmountTolerance', label: 'ผ่อนปรนยอดเงิน ±1.99 บาท', desc: 'เช็คส่วนต่างยอดโอนไม่เกิน 1.99 บาท ก่อนตัดสินใจปฏิเสธ' },
        { key: 'enableSenderAccountCheck', label: 'เช็คเลขบัญชีผู้โอน (เคสพิเศษ - ตาม Bank Map)', desc: 'ปิด = ชื่อบัญชีผู้โอนไม่ตรง ข้ามรายการทันทีเสมอ' },
        { key: 'enableRejectAmountMismatch', label: 'ปฏิเสธยอดเงินไม่ตรง (ทุกกรณี)', desc: 'ปิด = ยอดเงินไม่ตรง จะข้ามรายการไว้ให้เช็คเอง แทนการปฏิเสธ' },
        { key: 'enableSenderNameFuzzyCheck', label: 'เช็คชื่อผู้โอน Fuzzy (เฉพาะ กรุงเทพ/กรุงศรี)', desc: 'ปิด = ธ.กรุงเทพ/กรุงศรี ใช้แค่เช็คเลขบัญชีอย่างเดียวเหมือนธนาคารอื่น' },
        { key: 'enableReceiverNameCustomCheck', label: '📝 ใช้ชื่อผู้รับที่กำหนดเอง (ทุกธนาคาร)', desc: 'เมื่อ tag "ชื่อบัญชีผู้รับ" ขึ้นว่าไม่ตรง หรือไม่มี tag จะเทียบกับรายชื่อที่กรอกไว้ด้านล่างนี้', hasInput: 'receiverName' },
        { key: 'enableCustomLast4Override', label: '📝 ใช้ last4 ที่กำหนดเอง', desc: 'เมื่อ tag "last4 บัญชีรับ" ขึ้นว่าไม่ตรง จะเทียบกับเลขที่กรอกไว้ด้านล่างนี้แทน', hasInput: 'last4' },
        { key: 'enableSenderNameFuzzyCheckGeneral', label: 'เช็คชื่อผู้โอน Fuzzy ทั่วไป (ทุกธนาคาร)', desc: 'เมื่อ tag "ชื่อบัญชีผู้โอน" ไม่ตรง จะลองเทียบ "ชื่อจริงคำแรก" (ไทย/อังกฤษ ข้ามภาษาได้, เกณฑ์ 50%) ก่อน' },
        { key: 'enableAutoReOcr', label: 'Auto re-OCR สแกนค้าง (ทุก 10 วินาที)', desc: 'ปิด = ต้องกดปุ่ม re-OCR เอง, บอทจะไม่กดให้อัตโนมัติ' },
        { key: 'enableUniformBankMap', label: '⚡ Dynamic Length-Based Bank Map', desc: 'เปิด = ใช้ระบบประมวลผลความยาวอัตโนมัติ (10/12 หลัก ยกเว้น BBL/กรุงศรี/UOB) | ปิด = ใช้ Fixed Bank Rules' },
        { key: 'enableUobNameBypass', label: '🏦 UOB (TMRW): ข้ามการเทียบชื่อผู้โอน', desc: 'สลิป UOB ขึ้นชื่อผู้โอนเป็น "TMRW" ทุกรายการ เทียบชื่อไม่ได้ | เปิด = ใช้เลขบัญชีผู้โอนอย่างเดียว | ปิด = UOB ที่ชื่อไม่ตรงจะข้ามรายการให้เช็คเอง' },
    ];

    // --- ค่าที่กำหนดเอง: ชื่อบัญชีผู้รับ (ฝั่งสลิป) ---
    const RECEIVER_NAME_CUSTOM_KEY = 'autoApproveBot_receiverNameCustom_v1';

    function loadCustomReceiverName() {
        try {
            return localStorage.getItem(RECEIVER_NAME_CUSTOM_KEY) || '';
        } catch (e) {
            cLog.warn('อ่านค่าชื่อบัญชีผู้รับที่กำหนดเองจาก localStorage ไม่สำเร็จ: ' + e);
            return '';
        }
    }

    function saveCustomReceiverName(value) {
        try {
            localStorage.setItem(RECEIVER_NAME_CUSTOM_KEY, value);
        } catch (e) {
            cLog.warn('บันทึกค่าชื่อบัญชีผู้รับที่กำหนดเองลง localStorage ไม่สำเร็จ: ' + e);
        }
    }

    function parseCustomReceiverNameList(raw) {
        // รองรับตัวคั่น | ; และขึ้นบรรทัดใหม่
        // สำหรับค่ารูปแบบเดิมที่คั่นด้วย comma จะป้องกัน comma ภายใน "CO.,LTD." ก่อน
        const protectedRaw = (raw || '').replace(/CO\.\s*,\s*LTD\./gi, match =>
            match.replace(',', '__BOT_COMMA__')
        );

        return protectedRaw
            .split(/[|;\n,]+/)
            .map(s => s.replace(/__BOT_COMMA__/g, ',').trim().replace(/\s+/g, ' '))
            .filter(Boolean);
}

    // --- ค่าที่กำหนดเอง: last4 บัญชีรับ ---
    const CUSTOM_LAST4_KEY = 'autoApproveBot_customLast4_v1';

    function loadCustomLast4Raw() {
        try {
            return localStorage.getItem(CUSTOM_LAST4_KEY) || '';
        } catch (e) {
            cLog.warn('อ่านค่า last4 ที่กำหนดเองจาก localStorage ไม่สำเร็จ: ' + e);
            return '';
        }
    }

    function parseCustomLast4List(raw) {
        return (raw || '')
            .split(',')
            .map(s => s.trim())
            .filter(s => /^\d{4}$/.test(s));
    }

    function saveCustomLast4Raw(value) {
        try {
            localStorage.setItem(CUSTOM_LAST4_KEY, value);
        } catch (e) {
            cLog.warn('บันทึกค่า last4 ที่กำหนดเองลง localStorage ไม่สำเร็จ: ' + e);
        }
    }

    // --- Premium UI / Theme ---
    const styleTag = document.createElement('style');
    styleTag.textContent = `
        @keyframes abot-float {
            0%, 100% { transform: translateY(0); }
            50% { transform: translateY(-3px); }
        }

        @keyframes abot-glow {
            0%, 100% { opacity: .55; transform: scale(.98); }
            50% { opacity: 1; transform: scale(1.02); }
        }

        @keyframes abot-spin {
            to { transform: rotate(360deg); }
        }

        @keyframes abot-pulse {
            0%, 100% { box-shadow: 0 0 0 0 rgba(88, 242, 170, 0); }
            50% { box-shadow: 0 0 0 7px rgba(88, 242, 170, .08); }
        }

        @keyframes abot-panel-in {
            0% { opacity: 0; transform: translateY(12px) scale(.97); filter: blur(6px); }
            100% { opacity: 1; transform: translateY(0) scale(1); filter: blur(0); }
        }

        @keyframes abot-shine {
            0% { transform: translateX(-130%) skewX(-18deg); }
            100% { transform: translateX(180%) skewX(-18deg); }
        }

        .abot-shell {
            position: fixed !important;
            right: 22px !important;
            bottom: 22px !important;
            z-index: 2147483000 !important;
            display: flex !important;
            flex-direction: column !important;
            align-items: center !important;
            gap: 9px !important;
            font-family: "Prompt", "Inter", "Segoe UI", Tahoma, sans-serif !important;
            user-select: none !important;
            isolation: isolate !important;
        }

        .abot-shell::before {
            content: "";
            position: absolute;
            width: 92px;
            height: 92px;
            right: -18px;
            bottom: -18px;
            border-radius: 50%;
            background: radial-gradient(circle, rgba(96, 165, 250, .22), rgba(124, 58, 237, .10) 45%, transparent 72%);
            filter: blur(14px);
            z-index: -1;
            pointer-events: none;
            animation: abot-glow 4s ease-in-out infinite;
        }

        .abot-controls-row {
            display: flex !important;
            align-items: center !important;
            justify-content: center !important;
            gap: 10px !important;
        }

        .abot-settings-btn,
        .abot-start-btn {
            position: relative !important;
            border: 1px solid rgba(255,255,255,.14) !important;
            color: #f8fafc !important;
            cursor: pointer !important;
            overflow: hidden !important;
            transform: translateZ(0);
            -webkit-tap-highlight-color: transparent;
        }

        .abot-settings-btn {
            width: 42px !important;
            height: 42px !important;
            border-radius: 14px !important;
            font-size: 17px !important;
            font-weight: 700 !important;
            background: linear-gradient(145deg, rgba(30,41,59,.96), rgba(15,23,42,.94)) !important;
            box-shadow:
                0 14px 28px rgba(2, 6, 23, .34),
                inset 0 1px 0 rgba(255,255,255,.08),
                inset 0 -1px 0 rgba(0,0,0,.28) !important;
            transition: transform .22s ease, box-shadow .22s ease, border-color .22s ease !important;
        }

        .abot-settings-btn::before,
        .abot-start-btn::before {
            content: "";
            position: absolute;
            inset: 0;
            pointer-events: none;
            background: linear-gradient(120deg, transparent 0%, rgba(255,255,255,.08) 44%, rgba(255,255,255,.22) 50%, transparent 58%);
            transform: translateX(-130%) skewX(-18deg);
        }

        .abot-settings-btn:hover {
            transform: translateY(-2px) rotate(2deg) !important;
            border-color: rgba(125,211,252,.45) !important;
            box-shadow:
                0 16px 34px rgba(2, 6, 23, .42),
                0 0 0 1px rgba(96,165,250,.10),
                inset 0 1px 0 rgba(255,255,255,.10) !important;
        }

        .abot-settings-btn:hover::before,
        .abot-start-btn:hover::before {
            animation: abot-shine .75s ease;
        }

        .abot-settings-btn:active,
        .abot-start-btn:active {
            transform: scale(.94) !important;
        }

        .abot-start-btn {
            width: 60px !important;
            height: 60px !important;
            border-radius: 18px !important;
            font-size: 20px !important;
            font-weight: 800 !important;
            letter-spacing: .2px !important;
            background: linear-gradient(145deg, #22c55e, #0f9f68 55%, #0b7a58) !important;
            box-shadow:
                0 18px 35px rgba(5, 46, 22, .34),
                inset 0 1px 0 rgba(255,255,255,.18),
                inset 0 -2px 0 rgba(0,0,0,.18) !important;
            transition: transform .22s cubic-bezier(.2,.8,.2,1), box-shadow .22s ease, background .22s ease, border-color .22s ease !important;
            animation: abot-float 4.2s ease-in-out infinite;
        }

        .abot-start-btn.is-running {
            background: linear-gradient(145deg, #ff5d73, #e11d48 58%, #a91036) !important;
            box-shadow:
                0 18px 35px rgba(136, 19, 55, .34),
                0 0 0 1px rgba(255,255,255,.04),
                inset 0 1px 0 rgba(255,255,255,.18),
                inset 0 -2px 0 rgba(0,0,0,.2) !important;
            animation: abot-float 4.2s ease-in-out infinite, abot-pulse 2.5s ease-in-out infinite;
        }

        .abot-start-btn.is-stopped {
            background: linear-gradient(145deg, #34d399, #10b981 55%, #087f62) !important;
        }

        .abot-start-btn:hover {
            transform: translateY(-3px) scale(1.02) !important;
            box-shadow:
                0 22px 42px rgba(2,6,23,.34),
                0 0 0 1px rgba(255,255,255,.05),
                inset 0 1px 0 rgba(255,255,255,.22),
                inset 0 -2px 0 rgba(0,0,0,.18) !important;
        }

        .abot-status-label {
            display: inline-flex !important;
            align-items: center !important;
            gap: 7px !important;
            min-height: 28px !important;
            padding: 5px 10px !important;
            border: 1px solid rgba(255,255,255,.10) !important;
            border-radius: 999px !important;
            background: rgba(9, 14, 27, .78) !important;
            color: #eef2ff !important;
            font-size: 11px !important;
            font-weight: 700 !important;
            letter-spacing: .15px !important;
            white-space: nowrap !important;
            backdrop-filter: blur(16px) saturate(1.3) !important;
            -webkit-backdrop-filter: blur(16px) saturate(1.3) !important;
            box-shadow:
                0 10px 24px rgba(2,6,23,.28),
                inset 0 1px 0 rgba(255,255,255,.06) !important;
            transition: background .22s ease, border-color .22s ease, box-shadow .22s ease !important;
        }

        .abot-status-label.is-running {
            background: rgba(7, 42, 29, .78) !important;
            border-color: rgba(52, 211, 153, .24) !important;
            box-shadow: 0 10px 24px rgba(5,46,22,.28), 0 0 24px rgba(16,185,129,.08), inset 0 1px 0 rgba(255,255,255,.06) !important;
        }

        .abot-status-label.is-stopped {
            background: rgba(9, 14, 27, .78) !important;
        }

        .abot-status-dot {
            width: 8px !important;
            height: 8px !important;
            min-width: 8px !important;
            border-radius: 50% !important;
            background: #94a3b8 !important;
            box-shadow: 0 0 0 3px rgba(148,163,184,.10) !important;
            transition: background .22s ease, box-shadow .22s ease, transform .22s ease !important;
        }

        .abot-status-dot.is-running {
            background: #34d399 !important;
            box-shadow: 0 0 0 3px rgba(52,211,153,.10), 0 0 14px rgba(52,211,153,.78) !important;
            animation: abot-pulse 2s ease-in-out infinite;
        }

        .abot-settings-panel {
            display: none;
            width: 318px !important;
            max-width: min(318px, calc(100vw - 24px)) !important;
            max-height: min(68vh, 680px) !important;
            overflow-y: auto !important;
            overflow-x: hidden !important;
            box-sizing: border-box !important;
            padding: 14px !important;
            border: 1px solid rgba(148,163,184,.16) !important;
            border-radius: 20px !important;
            background:
                radial-gradient(circle at 100% 0%, rgba(59,130,246,.15), transparent 32%),
                radial-gradient(circle at 0% 100%, rgba(139,92,246,.12), transparent 36%),
                linear-gradient(145deg, rgba(15,23,42,.96), rgba(8,15,29,.94)) !important;
            box-shadow:
                0 26px 70px rgba(2,6,23,.48),
                0 10px 30px rgba(15,23,42,.28),
                inset 0 1px 0 rgba(255,255,255,.08) !important;
            backdrop-filter: blur(22px) saturate(1.35) !important;
            -webkit-backdrop-filter: blur(22px) saturate(1.35) !important;
            scrollbar-width: thin !important;
            scrollbar-color: rgba(148,163,184,.34) transparent !important;
        }

        .abot-settings-panel.abot-panel-pop {
            animation: abot-panel-in .24s cubic-bezier(.2,.8,.2,1) both;
        }

        .abot-settings-panel::-webkit-scrollbar { width: 6px; }
        .abot-settings-panel::-webkit-scrollbar-track { background: transparent; }
        .abot-settings-panel::-webkit-scrollbar-thumb {
            background: linear-gradient(180deg, rgba(96,165,250,.55), rgba(167,139,250,.45));
            border-radius: 999px;
        }

        .abot-panel-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
            padding: 2px 2px 12px;
            margin-bottom: 2px;
            border-bottom: 1px solid rgba(255,255,255,.07);
        }

        .abot-panel-title-wrap {
            display: flex;
            align-items: center;
            gap: 10px;
            min-width: 0;
        }

        .abot-panel-icon {
            width: 34px;
            height: 34px;
            display: grid;
            place-items: center;
            border-radius: 11px;
            color: #e0f2fe;
            background: linear-gradient(145deg, rgba(59,130,246,.22), rgba(124,58,237,.20));
            border: 1px solid rgba(125,211,252,.16);
            box-shadow: inset 0 1px 0 rgba(255,255,255,.08), 0 8px 22px rgba(37,99,235,.10);
            animation: abot-glow 4s ease-in-out infinite;
        }

        .abot-panel-title {
            color: #f8fafc !important;
            font-size: 14px !important;
            font-weight: 800 !important;
            line-height: 1.2 !important;
            letter-spacing: .1px !important;
        }

        .abot-panel-subtitle {
            margin-top: 2px;
            color: rgba(203,213,225,.58);
            font-size: 10px;
            line-height: 1.35;
        }

        .abot-live-badge {
            flex-shrink: 0;
            padding: 4px 7px;
            border-radius: 999px;
            font-size: 9px;
            font-weight: 800;
            letter-spacing: .65px;
            color: #a7f3d0;
            background: rgba(16,185,129,.10);
            border: 1px solid rgba(52,211,153,.20);
            box-shadow: 0 0 16px rgba(16,185,129,.06);
        }

        .abot-group {
            position: relative;
            padding: 9px 0 10px !important;
            margin: 0 !important;
            border-bottom: 1px solid rgba(255,255,255,.065) !important;
            transition: transform .18s ease, background .18s ease !important;
        }

        .abot-group:last-child {
            border-bottom: none !important;
            padding-bottom: 2px !important;
        }

        .abot-group:hover {
            transform: translateX(2px);
        }

        .abot-toggle-row {
            display: flex !important;
            align-items: center !important;
            justify-content: space-between !important;
            gap: 12px !important;
            padding: 5px 2px !important;
        }

        .abot-toggle-text {
            display: flex !important;
            flex-direction: column !important;
            min-width: 0 !important;
        }

        .abot-toggle-label {
            font-size: 11.5px !important;
            font-weight: 750 !important;
            color: #f8fafc !important;
            line-height: 1.4 !important;
        }

        .abot-toggle-desc {
            font-size: 9.5px !important;
            color: rgba(203,213,225,.56) !important;
            margin-top: 2px !important;
            line-height: 1.45 !important;
        }

        .abot-input-section {
            margin-top: 8px !important;
            padding: 10px !important;
            background: linear-gradient(145deg, rgba(255,255,255,.055), rgba(255,255,255,.025)) !important;
            border: 1px solid rgba(148,163,184,.10) !important;
            border-left: 3px solid #60a5fa !important;
            border-radius: 13px !important;
            transition: opacity .18s ease, filter .18s ease, transform .18s ease, border-color .18s ease !important;
            box-shadow: inset 0 1px 0 rgba(255,255,255,.04) !important;
        }

        .abot-input-section:hover {
            border-color: rgba(96,165,250,.24) !important;
            transform: translateY(-1px);
        }

        .abot-input-section.abot-input-disabled {
            opacity: .34 !important;
            filter: saturate(.65) !important;
            pointer-events: none !important;
            transform: none !important;
        }

        .abot-input-label {
            font-size: 10.5px !important;
            font-weight: 800 !important;
            color: #f8fafc !important;
            margin-bottom: 3px !important;
        }

        .abot-input-desc {
            font-size: 9px !important;
            color: rgba(203,213,225,.50) !important;
            margin-bottom: 7px !important;
            line-height: 1.45 !important;
        }

        .abot-custom-input {
            width: 100% !important;
            box-sizing: border-box !important;
            padding: 8px 10px !important;
            font-size: 11px !important;
            line-height: 1.3 !important;
            border-radius: 10px !important;
            border: 1px solid rgba(148,163,184,.16) !important;
            outline: none !important;
            background: rgba(2,6,23,.38) !important;
            color: #f8fafc !important;
            caret-color: #60a5fa !important;
            box-shadow: inset 0 1px 0 rgba(255,255,255,.035) !important;
            transition: border-color .2s ease, box-shadow .2s ease, background .2s ease, transform .2s ease !important;
        }

        .abot-custom-input::placeholder { color: rgba(148,163,184,.42) !important; }

        .abot-custom-input:focus {
            border-color: rgba(96,165,250,.50) !important;
            background: rgba(15,23,42,.72) !important;
            box-shadow: 0 0 0 3px rgba(96,165,250,.08), inset 0 1px 0 rgba(255,255,255,.05) !important;
            transform: translateY(-1px) !important;
        }

        .abot-switch {
            position: relative !important;
            width: 40px !important;
            height: 22px !important;
            flex-shrink: 0 !important;
            display: inline-block !important;
        }

        .abot-switch input {
            opacity: 0 !important;
            width: 0 !important;
            height: 0 !important;
            position: absolute !important;
        }

        .abot-slider {
            position: absolute !important;
            cursor: pointer !important;
            inset: 0 !important;
            background: linear-gradient(145deg, #334155, #1e293b) !important;
            border: 1px solid rgba(148,163,184,.20) !important;
            transition: .22s cubic-bezier(.2,.8,.2,1) !important;
            border-radius: 999px !important;
            box-shadow: inset 0 1px 2px rgba(0,0,0,.25), 0 4px 10px rgba(2,6,23,.16) !important;
        }

        .abot-slider:before {
            position: absolute !important;
            content: "" !important;
            height: 16px !important;
            width: 16px !important;
            left: 2px !important;
            top: 2px !important;
            background: linear-gradient(145deg, #f8fafc, #cbd5e1) !important;
            transition: .22s cubic-bezier(.2,.8,.2,1) !important;
            border-radius: 50% !important;
            box-shadow: 0 2px 7px rgba(0,0,0,.30), inset 0 1px 0 rgba(255,255,255,.55) !important;
        }

        .abot-switch:hover .abot-slider {
            border-color: rgba(125,211,252,.28) !important;
        }

        .abot-switch input:checked + .abot-slider {
            background: linear-gradient(145deg, #34d399, #10b981) !important;
            border-color: rgba(110,231,183,.30) !important;
            box-shadow: inset 0 1px 2px rgba(0,0,0,.16), 0 0 16px rgba(16,185,129,.13) !important;
        }

        .abot-switch input:checked + .abot-slider:before {
            transform: translateX(18px) !important;
            background: linear-gradient(145deg, #ffffff, #ecfeff) !important;
        }

        @media (max-width: 520px) {
            .abot-shell {
                right: 12px !important;
                bottom: 12px !important;
            }
            .abot-settings-panel {
                width: calc(100vw - 24px) !important;
                max-width: calc(100vw - 24px) !important;
                max-height: 62vh !important;
            }
        }
    `;
    document.head.appendChild(styleTag);

    // --- สร้าง UI ปุ่มเริ่ม/หยุด และตั้งค่า ---
    const wrapper = document.createElement('div');
    wrapper.className = 'abot-shell';
    wrapper.style.position = 'fixed';
    wrapper.style.bottom = '22px';
    wrapper.style.right = '22px';
    wrapper.style.zIndex = '999999';
    wrapper.style.display = 'flex';
    wrapper.style.flexDirection = 'column';
    wrapper.style.alignItems = 'center';
    wrapper.style.gap = '9px';
    wrapper.style.fontFamily = '"Prompt", "Inter", "Segoe UI", Tahoma, sans-serif';

    const controlsRow = document.createElement('div');
    controlsRow.className = 'abot-controls-row';
    controlsRow.style.display = 'flex';
    controlsRow.style.alignItems = 'center';
    controlsRow.style.gap = '10px';

    const settingsBtn = document.createElement('button');
    settingsBtn.className = 'abot-settings-btn';
    settingsBtn.innerText = '⚙';
    settingsBtn.title = 'ตั้งค่าฟังก์ชันของบอท';
    settingsBtn.setAttribute('aria-label', 'ตั้งค่าฟังก์ชันของบอท');
    settingsBtn.style.width = '42px';
    settingsBtn.style.height = '42px';
    settingsBtn.style.borderRadius = '14px';
    settingsBtn.style.border = 'none';
    settingsBtn.style.cursor = 'pointer';
    settingsBtn.style.fontSize = '17px';
    settingsBtn.style.color = 'white';
    settingsBtn.style.backgroundColor = 'transparent';
    settingsBtn.style.boxShadow = 'none';

    const startBtn = document.createElement('button');
    startBtn.className = 'abot-start-btn abot-start-btn-ui';
    startBtn.innerText = '▶';
    startBtn.title = 'เริ่ม / หยุด การทำงานอัตโนมัติ';
    startBtn.setAttribute('aria-label', 'เริ่ม / หยุด การทำงานอัตโนมัติ');
    startBtn.style.width = '60px';
    startBtn.style.height = '60px';
    startBtn.style.borderRadius = '18px';
    startBtn.style.border = 'none';
    startBtn.style.cursor = 'pointer';
    startBtn.style.fontSize = '20px';
    startBtn.style.fontWeight = '800';
    startBtn.style.color = 'white';
    startBtn.style.backgroundColor = 'transparent';
    startBtn.style.boxShadow = 'none';
    startBtn.style.transition = 'transform 0.22s ease';

    startBtn.addEventListener('mousedown', () => startBtn.style.transform = 'scale(0.94)');
    startBtn.addEventListener('mouseup', () => startBtn.style.transform = '');
    startBtn.addEventListener('mouseleave', () => startBtn.style.transform = '');

    const statusLabel = document.createElement('div');
    statusLabel.className = 'abot-status-label abot-status-label-ui';
    statusLabel.style.fontSize = '11px';
    statusLabel.style.fontWeight = '700';
    statusLabel.style.padding = '5px 10px';
    statusLabel.style.borderRadius = '999px';
    statusLabel.style.backgroundColor = 'transparent';
    statusLabel.style.color = 'white';
    statusLabel.style.whiteSpace = 'nowrap';

    const statusDot = document.createElement('span');
    statusDot.className = 'abot-status-dot';

    const statusText = document.createElement('span');
    statusText.className = 'abot-status-text';
    statusText.innerText = 'หยุดทำงาน';

    statusLabel.appendChild(statusDot);
    statusLabel.appendChild(statusText);

    const settingsPanel = document.createElement('div');
    settingsPanel.className = 'abot-settings-panel';
    settingsPanel.style.display = 'none';
    settingsPanel.style.width = '318px';
    settingsPanel.style.maxHeight = '68vh';
    settingsPanel.style.overflowY = 'auto';
    settingsPanel.style.backgroundColor = 'transparent';
    settingsPanel.style.borderRadius = '20px';
    settingsPanel.style.padding = '14px';
    settingsPanel.style.boxShadow = 'none';

    const panelHeader = document.createElement('div');
    panelHeader.className = 'abot-panel-header';

    const panelTitleWrap = document.createElement('div');
    panelTitleWrap.className = 'abot-panel-title-wrap';

    const panelIcon = document.createElement('div');
    panelIcon.className = 'abot-panel-icon';
    panelIcon.innerText = '✦';
    panelIcon.setAttribute('aria-hidden', 'true');

    const panelTitleTextWrap = document.createElement('div');
    const settingsTitle = document.createElement('div');
    settingsTitle.className = 'abot-panel-title';
    settingsTitle.innerText = 'ตั้งค่าฟังก์ชันของบอท';

    const settingsSubtitle = document.createElement('div');
    settingsSubtitle.className = 'abot-panel-subtitle';
    settingsSubtitle.innerText = 'ปรับแต่งระบบตรวจสอบอัตโนมัติแบบเรียลไทม์';

    panelTitleTextWrap.appendChild(settingsTitle);
    panelTitleTextWrap.appendChild(settingsSubtitle);
    panelTitleWrap.appendChild(panelIcon);
    panelTitleWrap.appendChild(panelTitleTextWrap);

    const liveBadge = document.createElement('div');
    liveBadge.className = 'abot-live-badge';
    liveBadge.innerText = 'LIVE';

    panelHeader.appendChild(panelTitleWrap);
    panelHeader.appendChild(liveBadge);
    settingsPanel.appendChild(panelHeader);

    // --- ส่วนกรอกข้อมูล Custom ---
    const receiverNameSection = document.createElement('div');
    receiverNameSection.className = 'abot-input-section';

    const receiverNameLabel = document.createElement('div');
    receiverNameLabel.className = 'abot-input-label';
    receiverNameLabel.innerText = '👇 กรอกชื่อที่นี่ (ตรงกับสลิป)';

    const receiverNameDesc = document.createElement('div');
    receiverNameDesc.className = 'abot-input-desc';
    receiverNameDesc.innerText = 'ใส่ได้หลายชื่อ คั่นด้วย | หรือขึ้นบรรทัดใหม่ (รองรับชื่อบริษัทที่มี comma เช่น CO.,LTD.)';

    const receiverNameInput = document.createElement('input');
    receiverNameInput.type = 'text';
    receiverNameInput.className = 'abot-custom-input';
    receiverNameInput.placeholder = 'เช่น SINO O | JOHN D | ST HEAVY CO.,LTD.';
    receiverNameInput.value = loadCustomReceiverName();
    receiverNameInput.style.width = '100%';
    receiverNameInput.style.boxSizing = 'border-box';
    receiverNameInput.style.padding = '8px 10px';
    receiverNameInput.style.fontSize = '11px';
    receiverNameInput.style.borderRadius = '10px';
    receiverNameInput.style.border = '1px solid rgba(148,163,184,.16)';
    receiverNameInput.style.backgroundColor = 'rgba(2,6,23,.38)';
    receiverNameInput.style.color = 'white';
    receiverNameInput.addEventListener('change', () => {
        saveCustomReceiverName(receiverNameInput.value);
        cLog.info(`ตั้งค่า "ชื่อบัญชีผู้รับที่กำหนดเอง" -> "${receiverNameInput.value}"`);
    });

    receiverNameSection.appendChild(receiverNameLabel);
    receiverNameSection.appendChild(receiverNameDesc);
    receiverNameSection.appendChild(receiverNameInput);

    const last4Section = document.createElement('div');
    last4Section.className = 'abot-input-section';

    const last4Label = document.createElement('div');
    last4Label.className = 'abot-input-label';
    last4Label.innerText = '👇 กรอกเลข last4 ที่นี่';

    const last4Desc = document.createElement('div');
    last4Desc.className = 'abot-input-desc';
    last4Desc.innerText = 'ใส่ได้หลายชุด คั่นด้วย , เช่น 1234, 5678';

    const last4Input = document.createElement('input');
    last4Input.type = 'text';
    last4Input.className = 'abot-custom-input';
    last4Input.placeholder = 'เช่น 1234, 5678';
    last4Input.value = loadCustomLast4Raw();
    last4Input.style.width = '100%';
    last4Input.style.boxSizing = 'border-box';
    last4Input.style.padding = '8px 10px';
    last4Input.style.fontSize = '11px';
    last4Input.style.borderRadius = '10px';
    last4Input.style.border = '1px solid rgba(148,163,184,.16)';
    last4Input.style.backgroundColor = 'rgba(2,6,23,.38)';
    last4Input.style.color = 'white';
    last4Input.addEventListener('change', () => {
        saveCustomLast4Raw(last4Input.value);
        cLog.info(`ตั้งค่า "last4 บัญชีรับที่กำหนดเอง" -> "${last4Input.value}"`);
    });

    last4Section.appendChild(last4Label);
    last4Section.appendChild(last4Desc);
    last4Section.appendChild(last4Input);

    const inputSectionsByKey = {
        receiverName: receiverNameSection,
        last4: last4Section,
    };

    SETTINGS_FIELDS.forEach(field => {
        const group = document.createElement('div');
        group.className = 'abot-group';

        const row = document.createElement('div');
        row.className = 'abot-toggle-row';

        const textWrap = document.createElement('div');
        textWrap.className = 'abot-toggle-text';
        const labelEl = document.createElement('span');
        labelEl.className = 'abot-toggle-label';
        labelEl.innerText = field.label;
        const descEl = document.createElement('span');
        descEl.className = 'abot-toggle-desc';
        descEl.innerText = field.desc;
        textWrap.appendChild(labelEl);
        textWrap.appendChild(descEl);

        const switchLabel = document.createElement('label');
        switchLabel.className = 'abot-switch';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = !!settings[field.key];

        const linkedInputSection = field.hasInput ? inputSectionsByKey[field.hasInput] : null;
        if (linkedInputSection) {
            linkedInputSection.classList.toggle('abot-input-disabled', !checkbox.checked);
        }

        checkbox.addEventListener('change', () => {
            settings[field.key] = checkbox.checked;
            saveSettings();
            cLog.info(`ตั้งค่า "${field.label}" -> ${checkbox.checked ? 'เปิด' : 'ปิด'}`);

            if (linkedInputSection) {
                linkedInputSection.classList.toggle('abot-input-disabled', !checkbox.checked);
            }

            if (field.key === 'enableAutoReOcr') {
                if (checkbox.checked && isRunning) {
                    startAutoReOcrFeature();
                } else if (!checkbox.checked) {
                    stopAutoReOcrFeature();
                }
            }
        });
        const slider = document.createElement('span');
        slider.className = 'abot-slider';
        switchLabel.appendChild(checkbox);
        switchLabel.appendChild(slider);

        row.appendChild(textWrap);
        row.appendChild(switchLabel);
        group.appendChild(row);

        if (linkedInputSection) {
            group.appendChild(linkedInputSection);
        }

        settingsPanel.appendChild(group);
    });

    settingsBtn.addEventListener('click', () => {
        const shouldOpen = settingsPanel.style.display === 'none';
        settingsPanel.style.display = shouldOpen ? 'block' : 'none';
        if (shouldOpen) {
            settingsPanel.classList.remove('abot-panel-pop');
            requestAnimationFrame(() => settingsPanel.classList.add('abot-panel-pop'));
        } else {
            settingsPanel.classList.remove('abot-panel-pop');
        }
    });

    controlsRow.appendChild(settingsBtn);
    controlsRow.appendChild(startBtn);
    wrapper.appendChild(settingsPanel);
    wrapper.appendChild(controlsRow);
    wrapper.appendChild(statusLabel);
    document.body.appendChild(wrapper);

    function updateButtonUI() {
        if (isRunning) {
            startBtn.innerText = '⏸';
            startBtn.style.backgroundColor = 'transparent';
            startBtn.classList.add('is-running');
            startBtn.classList.remove('is-stopped');
            statusText.innerText = `กำลังทำงาน (คิว: ${queue.length})`;
            statusLabel.style.backgroundColor = 'transparent';
            statusLabel.classList.add('is-running');
            statusLabel.classList.remove('is-stopped');
            statusDot.classList.add('is-running');
        } else {
            startBtn.innerText = '▶';
            startBtn.style.backgroundColor = 'transparent';
            startBtn.classList.add('is-stopped');
            startBtn.classList.remove('is-running');
            statusText.innerText = 'หยุดทำงาน';
            statusLabel.style.backgroundColor = 'transparent';
            statusLabel.classList.add('is-stopped');
            statusLabel.classList.remove('is-running');
            statusDot.classList.remove('is-running');
        }
    }

    startBtn.addEventListener('click', () => {
        isRunning = !isRunning;
        updateButtonUI();
        try {
            localStorage.setItem(RUNNING_STATE_KEY, isRunning ? '1' : '0');
        } catch (e) {
            cLog.warn('บันทึกสถานะการทำงานลง localStorage ไม่สำเร็จ: ' + e);
        }
        if (isRunning) {
            cLog.bot('🚀 เริ่มทำงานระบบ Auto Bot (โหมดทำงานต่อเนื่อง) 🚀');
            emptyScanStreak = 0;
            isRefreshScheduled = false;
            scanForNewItems();
            if (settings.enableAutoReOcr) startAutoReOcrFeature();
        } else {
            cLog.bot('🚨 หยุดทำงานระบบ Auto Bot (ผู้ใช้กดหยุดเอง) 🚨');
            emptyScanStreak = 0;
            isRefreshScheduled = false;
            stopAutoReOcrFeature();
        }
    });

    try {
        if (localStorage.getItem(RUNNING_STATE_KEY) === '1') {
            isRunning = true;
            cLog.bot('✨ ตรวจพบสถานะทำงานค้างไว้จากก่อนหน้านี้ -> กลับมาทำงานต่ออัตโนมัติ ✨');
        }
    } catch (e) {
        cLog.warn('อ่านสถานะการทำงานจาก localStorage ไม่สำเร็จ: ' + e);
    }
    updateButtonUI();
    if (isRunning) {
        setTimeout(scanForNewItems, 1500);
        if (settings.enableAutoReOcr) setTimeout(startAutoReOcrFeature, 1500);
    }

    // --- Helpers ---
    function waitForElement(selector, timeout = 5000) {
        return new Promise((resolve, reject) => {
            const el = document.querySelector(selector);
            if (el) return resolve(el);

            const observer = new MutationObserver(() => {
                const element = document.querySelector(selector);
                if (element) {
                    resolve(element);
                    observer.disconnect();
                }
            });
            observer.observe(document.body, { childList: true, subtree: true });
            setTimeout(() => {
                observer.disconnect();
                reject(new Error(`Timeout waiting for selector: ${selector}`));
            }, timeout);
        });
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function isVisible(el) {
        if (!el) return false;
        if (el.offsetParent === null) return false;
        const style = window.getComputedStyle(el);
        return style.visibility !== 'hidden' && style.display !== 'none' && parseFloat(style.opacity) !== 0;
    }

    function logRecurringIssue(message) {
        cLog.error(`พบปัญหาเกิดขึ้นซ้ำหลายครั้งติดกัน: ${message} (บอทยังทำงานต่อเนื่อง ไม่หยุดอัตโนมัติ)`);
        consecutiveUnreadableChecks = 0;
    }

    function waitForButtonByText(text, timeout = 5000) {
        const findBtn = () => Array.from(document.querySelectorAll('button')).find(el => isVisible(el) && el.innerText.includes(text));

        const existing = findBtn();
        if (existing) return Promise.resolve(existing);

        return new Promise((resolve) => {
            let settled = false;
            const finish = (result) => {
                if (settled) return;
                settled = true;
                observer.disconnect();
                clearInterval(backupPoll);
                clearTimeout(timer);
                resolve(result);
            };

            const observer = new MutationObserver(() => {
                const btn = findBtn();
                if (btn) finish(btn);
            });
            observer.observe(document.body, {
                childList: true,
                subtree: true,
                attributes: true,
                characterData: true
            });

            const backupPoll = setInterval(() => {
                const btn = findBtn();
                if (btn) finish(btn);
            }, 150);

            const timer = setTimeout(() => finish(null), timeout);
        });
    }

    function recordTechnicalFailure(message) {
        consecutiveUnreadableChecks++;
        cLog.warn(`${message} (ความล้มเหลวทางเทคนิคติดกันครั้งที่ ${consecutiveUnreadableChecks})`);
        if (consecutiveUnreadableChecks >= MAX_CONSECUTIVE_UNREADABLE) {
            logRecurringIssue(`เกิดความล้มเหลวทางเทคนิค (หาปุ่ม/ข้อมูลไม่เจอ) ${MAX_CONSECUTIVE_UNREADABLE} รายการติดกัน`);
        }
    }

    function recordTechnicalSuccess() {
        consecutiveUnreadableChecks = 0;
    }

    // ============================================================
    // Auto re-OCR
    // ============================================================
    const SCAN_INTERVAL_MS = 10 * 1000;
    const CLICK_COOLDOWN_MS = 10 * 1000;
    const OCR_FAIL_TEXT = 'OCR ล้มเหลว';
    const REOCR_BTN_TEXT = 're-OCR';
    let lastClickTime = 0;
    let scanTimer = null;
    let overridesInstalled = false;

    function logReOcr(msg) {
        cLog.bot('[AutoReOCR] ' + new Date().toLocaleTimeString() + ' - ' + msg);
    }

    function installDialogOverrides() {
        if (overridesInstalled) return;
        overridesInstalled = true;
        try {
            const targets = [window];
            if (typeof unsafeWindow !== 'undefined' && unsafeWindow && unsafeWindow !== window) {
                targets.push(unsafeWindow);
            }
            targets.forEach(w => {
                try {
                    w.confirm = function (...args) {
                        logReOcr('พบ confirm() dialog: "' + (args[0] || '') + '" -> ตอบตกลงอัตโนมัติ');
                        return true;
                    };
                    w.alert = function (...args) {
                        logReOcr('พบ alert() dialog: "' + (args[0] || '') + '" -> ปิดอัตโนมัติ (ไม่บล็อกหน้าเว็บ)');
                    };
                } catch (innerErr) {
                    cLog.warn('[AutoReOCR] override dialog บน window เป้าหมายหนึ่งไม่สำเร็จ: ' + innerErr);
                }
            });
            logReOcr('ติดตั้ง dialog override เรียบร้อย');
        } catch (e) {
            cLog.warn('[AutoReOCR] ติดตั้ง dialog override ไม่สำเร็จ: ' + e);
        }
    }

    function findFailedOcrCount() {
        const spans = Array.from(document.querySelectorAll('span'))
            .filter(el => el.textContent && el.textContent.trim().includes(OCR_FAIL_TEXT));
        return spans.length;
    }

    function findReOcrButton() {
        const buttons = Array.from(document.querySelectorAll('button'));
        return buttons.find(
            btn => btn.textContent && btn.textContent.includes(REOCR_BTN_TEXT)
        ) || null;
    }

    async function closeAnyOcrResultPopup() {
        await sleep(800);
        const closeSelectors = [
            'div[role="dialog"] button[aria-label="Close"]',
            'div[role="dialog"] button[aria-label="ปิด"]',
            '[data-state="open"] button[aria-label="Close"]',
            '[data-state="open"] button[aria-label="ปิด"]',
        ];
        for (const sel of closeSelectors) {
            const closeBtn = document.querySelector(sel);
            if (closeBtn && isVisible(closeBtn)) {
                logReOcr('พบ popup หลังกด re-OCR -> กดปุ่มปิด');
                closeBtn.click();
                await sleep(300);
                return;
            }
        }
        const dialogButtons = Array.from(document.querySelectorAll('div[role="dialog"] button')).filter(b => isVisible(b));
        const textMatchBtn = dialogButtons.find(b => /^\s*(ปิด|ตกลง|OK|Close)\s*$/i.test(b.textContent || ''));
        if (textMatchBtn) {
            logReOcr('พบ popup หลังกด re-OCR -> กดปุ่ม "' + textMatchBtn.textContent.trim() + '" เพื่อปิด');
            textMatchBtn.click();
            await sleep(300);
            return;
        }
        if (document.querySelector('div[role="dialog"]')) {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
            await sleep(300);
        }
    }

    async function scanAndActReOcr() {
        if (!isRunning) return;
        if (isProcessing) return;
        try {
            const now = Date.now();
            if (now - lastClickTime < CLICK_COOLDOWN_MS) return;

            const failedCount = findFailedOcrCount();
            if (failedCount === 0) return;

            const btn = findReOcrButton();
            if (!btn || btn.disabled) return;

            logReOcr('พบ ' + failedCount + ' รายการ OCR ล้มเหลว -> กดปุ่ม re-OCR');
            btn.click();
            lastClickTime = Date.now();
            await closeAnyOcrResultPopup();
        } catch (e) {
            cLog.warn('[AutoReOCR] เกิดข้อผิดพลาดระหว่างสแกน/กด re-OCR: ' + e);
        }
    }

    function startAutoReOcrFeature() {
        installDialogOverrides();
        scanAndActReOcr();
        if (scanTimer) clearInterval(scanTimer);
        scanTimer = setInterval(scanAndActReOcr, SCAN_INTERVAL_MS);
        logReOcr('เริ่มทำงาน Auto re-OCR ทุก 10 วินาที');
    }

    function stopAutoReOcrFeature() {
        if (scanTimer) {
            clearInterval(scanTimer);
            scanTimer = null;
        }
        logReOcr('หยุดทำงาน Auto re-OCR');
    }

    // --- 1. สแกนรายการใหม่ ---
    function scanForNewItems() {
        if (!isRunning) return;

        const pendingRows = document.querySelectorAll('tr.is-pending');
        const newlyQueued = [];

        // เพิ่มรายการทั้งหมดก่อน แล้วจึง log ให้เห็นครบในรอบสแกนเดียว
        pendingRows.forEach(row => {
            if (!row.getAttribute('data-bot-queued')) {
                row.setAttribute('data-bot-queued', 'true');
                const item = { row, orderNo: getOrderNoFromRow(row) };
                queue.push(item);
                newlyQueued.push(item);
            }
        });

        const foundNew = newlyQueued.length > 0;
        if (foundNew) {
            cLog.yellow(`พบรายการใหม่ทั้งหมด ${newlyQueued.length} รายการ -> เพิ่มเข้า Queue เรียบร้อย`);
            newlyQueued.forEach((item, index) => {
                cLog.yellow(`พบรายการใหม่ ${index + 1} : ${item.orderNo || 'ไม่พบเลข ORD'} แอดเข้า Queue สำเร็จ`);
            });
        }

        updateButtonUI();
        processQueue();

        if (!foundNew && queue.length === 0 && !isProcessing) {
            emptyScanStreak++;
            if (emptyScanStreak >= REFRESH_AFTER_EMPTY_SCANS) {
                cLog.info(`ไม่พบรายการค้างในคิวต่อเนื่อง ${emptyScanStreak} รอบ -> เตรียมรีเฟรชหน้าเพื่อสแกนใหม่`);
                scheduleAutoRefresh();
                return;
            }
        } else {
            emptyScanStreak = 0;
        }

        setTimeout(scanForNewItems, 1500);
    }

    function scheduleAutoRefresh() {
        if (isRefreshScheduled) return;
        isRefreshScheduled = true;
        cLog.info(`คิวว่าง -> จะรีเฟรชหน้าใน ${REFRESH_DELAY_MS / 1000} วินาที เพื่อวนรันใหม่...`);

        setTimeout(() => {
            isRefreshScheduled = false;
            if (!isRunning || queue.length > 0 || isProcessing) {
                emptyScanStreak = 0;
                if (isRunning) setTimeout(scanForNewItems, 1500);
                return;
            }
            cLog.bot('--- คิวว่างจริง -> รีเฟรชหน้าเพื่อวนรันใหม่ ---');
            try {
                location.reload();
            } catch (e) {
                cLog.error('รีเฟรชหน้าไม่สำเร็จ: ' + e);
                emptyScanStreak = 0;
                if (isRunning) setTimeout(scanForNewItems, 1500);
            }
        }, REFRESH_DELAY_MS);
    }

    // --- 2. การจัดคิวทำงาน ---
    async function processQueue() {
        if (isProcessing || queue.length === 0 || !isRunning) return;
        isProcessing = true;

        const currentItem = queue.shift();
        updateButtonUI();
        try {
            await handleRowProcessing(currentItem);
        } catch (error) {
            cLog.error('เกิดข้อผิดพลาดในการประมวลผลรายการนี้: ' + error);
        } finally {
            try {
                await closePopup();
            } catch (e) {
                cLog.error('ปิด popup ไม่สำเร็จ: ' + e);
            }
            isProcessing = false;
            processQueue();
        }
    }

    function getOrderNoFromRow(row) {
        if (!row) return null;
        const m = row.innerText.match(/ORD-\S+/);
        return m ? m[0].replace(/[^\w-]+$/, '') : null;
    }

    function findSlipClaimRowByOrderNo(orderNo) {
        const rows = document.querySelectorAll('tr');
        for (const r of rows) {
            if (isVisible(r) && r.innerText.includes(orderNo)) return r;
        }
        return null;
    }

    // --- 3. ขั้นตอนการประมวลผลแต่ละรายการ ---
    async function handleRowProcessing(item) {
        const orderNo = item && item.orderNo;
        let row = (item && item.row) || null;

        if (orderNo) {
            const liveRow = findSlipClaimRowByOrderNo(orderNo);
            if (liveRow) row = liveRow;
        }

        if (!row || !row.isConnected) {
            cLog.warn(`ไม่พบแถวของรายการนี้ในหน้าปัจจุบัน${orderNo ? ` (ออเดอร์: ${orderNo})` : ''} -> ข้ามรายการนี้`);
            return;
        }

        const viewBtn = row.querySelector('button.mng-rowview[aria-label="ดูรายละเอียด"]');
        if (!viewBtn) {
            recordTechnicalFailure('หาปุ่ม "ดูรายละเอียด" ในแถวไม่เจอ');
            return;
        }

        cLog.step('กำลังกดดูรายละเอียด...');
        viewBtn.click();

        try {
            await waitForElement('div.text-muted-foreground', 8000);
        } catch (e) {
            recordTechnicalFailure('รอ popup โหลดนานเกินไป (8 วิ)');
            await closePopup();
            return;
        }
        await sleep(80);

        const getPopupRowStatus = (titleText) => {
            const labelCandidates = document.querySelectorAll('div.text-muted-foreground');
            for (const label of labelCandidates) {
                if (!isVisible(label)) continue;
                if (label.innerText.trim() !== titleText.trim()) continue;

                const row = label.closest('[class*="grid-cols-"]')
                    || label.closest('[class*="grid"], [class*="flex"]')
                    || label.parentElement;
                if (!row) continue;

                const badgeCandidates = row.querySelectorAll('span.inline-flex, span[class*="bg-"], span[class*="text-"]');
                let matched = null;
                for (const badge of badgeCandidates) {
                    if (!isVisible(badge)) continue;
                    const text = badge.innerText.trim();
                    if (!text) continue;

                    let kind = null;
                    if (text.includes('ไม่ตรง')) kind = 'ไม่ตรง';
                    else if (text.includes('ตรง')) kind = 'ตรง';
                    if (!kind) continue;

                    if (matched && matched !== kind) return null;
                    matched = kind;
                }

                if (matched) return matched;
                return null;
            }
            return null;
        };

        const getPopupRowValues = (titleText) => {
            const labelCandidates = document.querySelectorAll('div.text-muted-foreground');
            for (const label of labelCandidates) {
                if (!isVisible(label)) continue;
                if (label.innerText.trim() !== titleText.trim()) continue;

                const row = label.closest('[class*="grid-cols-"]')
                    || label.closest('[class*="grid"], [class*="flex"]')
                    || label.parentElement;
                if (!row) continue;

                const children = Array.from(row.children).filter(child => isVisible(child));
                if (children.length < 3) return null;

                return {
                    orderText: children[1].innerText.trim(),
                    slipText: children[2].innerText.trim()
                };
            }
            return null;
        };

        let statusAmount = getPopupRowStatus('ยอดเงิน');
        let statusLast4 = getPopupRowStatus('last4 บัญชีรับ');
        let statusReceiverName = getPopupRowStatus('ชื่อบัญชีผู้รับ');
        let statusSenderName = getPopupRowStatus('ชื่อบัญชีผู้โอน');

        cLog.group(`รายการฝาก ${orderNo || ''}`);
        cLog.info(`ยอดเงิน: ${statusAmount} | last4: ${statusLast4} | ผู้รับ: ${statusReceiverName} | ผู้โอน: ${statusSenderName}`);

        // เริ่มเตรียมผลตรวจชื่อผู้โอนระหว่างตรวจเงื่อนไขอื่น เพื่อนำผลมาใช้ซ้ำภายหลัง
        const senderNameValuesPreload = getPopupRowValues('ชื่อบัญชีผู้โอน');
        let senderTranslationPreloadPromise = null;
        if (statusSenderName === 'ไม่ตรง' && settings.enableSenderNameFuzzyCheckGeneral && senderNameValuesPreload) {
            const preloadOrder = getFirstNameInfo(senderNameValuesPreload.orderText);
            const preloadSlip = getFirstNameInfo(senderNameValuesPreload.slipText);
            if (preloadOrder.first && preloadSlip.first && preloadOrder.lang !== preloadSlip.lang) {
                const thaiSide = preloadOrder.lang === 'TH' ? preloadOrder : preloadSlip;
                const enSide = preloadOrder.lang === 'TH' ? preloadSlip : preloadOrder;
                // เตรียมเฉพาะข้อมูลแปล ไม่ตัดสินผล/ไม่บันทึก miss จนกว่าจะถึงขั้นตรวจชื่อจริง
                senderTranslationPreloadPromise = Promise.all([
                    translateThaiFirstNameInfo(thaiSide.first),
                    translateEnglishFirstNameToThaiDictionary(enSide.first)
                ]).catch(error => {
                    cLog.warn('เตรียมผลแปลล่วงหน้าไม่สำเร็จ จะลองใหม่เมื่อถึงขั้นตรวจชื่อ: ' + error);
                    return null;
                });
            }
        }

        if (statusAmount === null && statusLast4 === null && statusReceiverName === null && statusSenderName === null) {
            recordTechnicalFailure('อ่านสถานะไม่ได้เลยสักจุด');
            cLog.groupEnd();
            await closePopup();
            return;
        } else {
            recordTechnicalSuccess();
        }

        // ============================================================
        // 🔍 เพิ่มเงื่อนไข: ตรวจสอบกรณีไม่พบข้อมูลให้ตรวจสอบ ข้ามรายการทันที
        // ============================================================
        if (statusAmount === null || statusLast4 === null) {
            cLog.success('ไม่พบข้อมูลให้ตรวจสอบ ข้ามรายการทันที');
            cLog.groupEnd();
            await closePopup();
            return;
        }

        // ============================================================
        // 🔴 เงื่อนไขที่ 1: Tag last4 ไม่ตรง (รองรับหลายบัญชี / Override ด้วยค่าที่กำหนดเอง)
        // ============================================================
        if (statusLast4 === 'ไม่ตรง') {
            if (settings.enableCustomLast4Override) {
                const last4Values = getPopupRowValues('last4 บัญชีรับ');
                if (checkCustomLast4Match(last4Values)) {
                    cLog.success('last4 ไม่ตรงตามเว็บ แต่ตรงกับ 1 ในบัญชีที่กำหนดไว้ -> override เป็น "ตรง"');
                    statusLast4 = 'ตรง';
                }
            }

            if (statusLast4 === 'ไม่ตรง') {
                cLog.error('Tag last4 บัญชีรับ "ไม่ตรง" ทุกบัญชี -> ปฏิเสธทันทีทุกกรณี!');
                cLog.groupEnd();
                await rejectOrder('🏛️บัญชีปลายทาง Order ฝากนี้ไม่ใช่ของทางเรานะคะ รบกวนทำการตรวจสอบสลิปใหม่อีกครั้งนะคะ');
                return;
            }
        }

        // ============================================================
        // 🔴 เงื่อนไขที่ 2: เช็คยอดเงิน ±1.99 บาท -> หากยังไม่ตรง ปฏิเสธทันที!
        // ============================================================
        const AMOUNT_TOLERANCE = 1.99;
        if (statusAmount === 'ไม่ตรง') {
            let isTolerancePass = false;

            // 2.1 ตรวจสอบฟังก์ชัน ผ่อนปรนยอดเงิน ±1.99 บาท (ถ้าเปิดใช้งาน)
            if (settings.enableAmountTolerance) {
                const amountValues = getPopupRowValues('ยอดเงิน');
                if (amountValues) {
                    const orderAmount = parseAmountText(amountValues.orderText);
                    const slipAmount = parseAmountText(amountValues.slipText);

                    if (orderAmount !== null && slipAmount !== null) {
                        const diff = Math.round(Math.abs(slipAmount - orderAmount) * 100) / 100;
                        cLog.step(`เช็คยอดเงินเพิ่มเติม -> ออเดอร์: ${orderAmount}, สลิป: ${slipAmount}, ผลต่าง: ${diff.toFixed(2)}`);
                        if (diff <= AMOUNT_TOLERANCE) {
                            cLog.success(`ผลต่างไม่เกิน ${AMOUNT_TOLERANCE} บาท -> ถือว่ายอดเงินตรง (override เป็น 'ตรง')`);
                            statusAmount = 'ตรง';
                            isTolerancePass = true;
                        }
                    }
                }
            } else {
                cLog.info('(ปิดฟังก์ชันผ่อนปรนยอดเงิน -> ไม่ได้เช็คส่วนต่าง ±1.99)');
            }

            // 2.2 ถ้ายอดเงินยังคง "ไม่ตรง" หลังเช็คผ่อนปรนแล้ว -> ปฏิเสธทันทีทุกกรณี!
            if (!isTolerancePass) {
                if (!settings.enableRejectAmountMismatch) {
                    cLog.warn('(ปิดฟังก์ชันปฏิเสธยอดเงินไม่ตรง -> ข้ามรายการนี้ไว้ให้เช็คเอง)');
                    cLog.groupEnd();
                    await closePopup();
                    return;
                }
                cLog.error('Tag ยอดเงิน "ไม่ตรง" (หลังเช็คผ่อนปรนแล้ว) -> ปฏิเสธทันที!');
                cLog.groupEnd();

                const amountVals = getPopupRowValues('ยอดเงิน');
                const rejectReason = amountVals
                    ? `รายการฝาก Order กับยอดในสลิปฝากไม่ตรงกัน จำนวน (ออเดอร์: ${amountVals.orderText}, สลิป: ${amountVals.slipText}) รบกวนคุณลูกค้าตรวจสอบข้อมูลให้ตรงกันนะคะ`
                    : `รายการฝาก Order กับยอดในสลิปฝากไม่ตรงกัน รบกวนคุณลูกค้าตรวจสอบข้อมูลให้ตรงกันนะคะ`;

                await rejectOrder(rejectReason);
                return;
            }
        }
        // ============================================================
        // ⚡ ตรวจนับ TAG ทั้งหมด (ทั้งตรงและไม่ตรง)
        // ============================================================
        const presentTags = [];
        if (statusAmount !== null) presentTags.push('amount');
        if (statusLast4 !== null) presentTags.push('last4');
        if (statusReceiverName !== null) presentTags.push('receiverName');
        if (statusSenderName !== null) presentTags.push('senderName');

        const totalTagCount = presentTags.length;
        cLog.info(`จำนวน Tag ทั้งหมดใน Popup นี้: ${totalTagCount} Tag [${presentTags.join(', ')}]`);

        // --- เพิ่มเงื่อนไขตรวจสอบเฉพาะ: กรณีไม่มี Tag "ชื่อบัญชีผู้รับ" ---
        if (!presentTags.includes('receiverName')) {
            cLog.step('ไม่พบ Tag "ชื่อบัญชีผู้รับ" ใน Popup -> ต้องผ่านการตรวจชื่อบัญชีผู้รับที่กำหนดเองก่อน');
            if (!settings.enableReceiverNameCustomCheck) {
                cLog.warn('(ปิดฟังก์ชันชื่อบัญชีผู้รับที่กำหนดเอง -> ไม่สามารถตรวจสอบชื่อผู้รับได้ -> ข้ามรายการนี้)');
                cLog.groupEnd();
                await closePopup();
                return;
            }
            const receiverNameValues = getPopupRowValues('ชื่อบัญชีผู้รับ');
            const isReceiverMatch = checkReceiverNameCustomMatch(receiverNameValues);
            if (!isReceiverMatch) {
                cLog.error('ชื่อบัญชีผู้รับฝั่งสลิปไม่ตรงกับรายชื่อที่กำหนดเอง -> ข้ามรายการนี้');
                cLog.groupEnd();
                await closePopup();
                return;
            }
            cLog.success('ชื่อบัญชีผู้รับตรงกับรายชื่อที่กำหนดเอง');
            statusReceiverName = 'ตรง'; // 👈 **เพิ่มบรรทัดนี้เข้าไปตรงนี้ครับ**
        }

        // --- กรณีที่ 1: ทั้ง popup มี 4 Tag ---
        if (totalTagCount === 4) {
            if (statusAmount === 'ตรง' && statusLast4 === 'ตรง' && statusReceiverName === 'ตรง' && statusSenderName === 'ตรง') {
                cLog.success('[กรณี 1: 4 Tag] สถานะขึ้นว่า "ตรง" ครบทั้ง 4 Tag -> อนุมัติทันที');
                cLog.groupEnd();
                await approveOrder();
                return;
            } else {
                cLog.info('[กรณี 1: 4 Tag] มี Tag ไม่ตรง -> ส่งต่อเข้าสู่เงื่อนไขย่อยตรวจสอบแบบละเอียด');
            }
        }
        // --- กรณีที่ 2: ทั้ง popup มี 3 Tag (ยอดเงิน + last4 + ชื่อบัญชีผู้รับ) ---
        else if (totalTagCount === 3 && presentTags.includes('amount') && presentTags.includes('last4') && presentTags.includes('receiverName')) {
            if (statusAmount === 'ตรง' && statusLast4 === 'ตรง' && statusReceiverName === 'ตรง') {
                cLog.success('[กรณี 2: 3 Tag (ยอดเงิน/last4/ชื่อผู้รับ)] ตรงครบทั้ง 3 Tag -> อนุมัติทันที');
                cLog.groupEnd();
                await approveOrder();
                return;
            } else {
                cLog.error('[กรณี 2: 3 Tag (ยอดเงิน/last4/ชื่อผู้รับ)] ไม่ตรงแม้แต่อันเดียว -> ข้ามรายการทันที');
                cLog.groupEnd();
                await closePopup();
                return;
            }
        }
        // --- กรณีที่ 3: ทั้ง popup มี 3 Tag (ยอดเงิน + last4 + ชื่อบัญชีผู้โอน) ---
        else if (totalTagCount === 3 && presentTags.includes('amount') && presentTags.includes('last4') && presentTags.includes('senderName')) {
            if (statusAmount === 'ตรง' && statusLast4 === 'ตรง' && statusSenderName === 'ตรง') {
                cLog.success('[กรณี 3: 3 Tag (ยอดเงิน/last4/ชื่อผู้โอน)] ตรงครบทั้ง 3 Tag -> อนุมัติทันที');
                cLog.groupEnd();
                await approveOrder();
                return;
            } else {
                cLog.info('[กรณี 3: 3 Tag (ยอดเงิน/last4/ชื่อผู้โอน)] มี Tag ไม่ตรง -> ส่งต่อเข้าสู่เงื่อนไขย่อยตรวจสอบแบบละเอียด');
            }
        }
        // --- กรณีที่ 4: ทั้ง popup มี 2 Tag (ยอดเงิน + last4) ---
        else if (totalTagCount === 2 && presentTags.includes('amount') && presentTags.includes('last4')) {
            if (statusAmount === 'ตรง' && statusLast4 === 'ตรง') {
                cLog.success('[กรณี 4: 2 Tag (ยอดเงิน/last4)] ตรงครบทั้ง 2 Tag -> อนุมัติทันที');
                cLog.groupEnd();
                await approveOrder();
                return;
            } else {
                cLog.error('[กรณี 4: 2 Tag (ยอดเงิน/last4)] ไม่ตรง -> ข้ามรายการทันที');
                cLog.groupEnd();
                await closePopup();
                return;
            }
        }
        else {
            cLog.info(`ไม่ตรงกับรูปแบบ Tag มาตรฐานข้างต้น (รวม ${totalTagCount} Tag) -> ส่งเข้าเงื่อนไขย่อยเดิม`);
        }

        // ============================================================
        // 🛠️ เงื่อนไขย่อย / การตรวจสอบเฉพาะ (ทำงานเดิมทั้งหมด)
        // ============================================================

        // --- ใช้ชื่อบัญชีผู้รับที่กำหนดเอง เมื่อ tag "ชื่อบัญชีผู้รับ" ขึ้นว่าไม่ตรง (ทุกธนาคาร) ---
        if (!settings.enableReceiverNameCustomCheck) {
            cLog.info('(ปิดฟังก์ชันชื่อบัญชีผู้รับที่กำหนดเอง -> ยึดสถานะชื่อบัญชีผู้รับจากเว็บตามเดิม)');
        } else if (statusReceiverName === 'ไม่ตรง') {
            const receiverNameValuesForOverride = getPopupRowValues('ชื่อบัญชีผู้รับ');
            if (receiverNameValuesForOverride) {
                const isReceiverNameCustomMatch = checkReceiverNameCustomMatch(receiverNameValuesForOverride);
                if (isReceiverNameCustomMatch) {
                    cLog.success('ชื่อบัญชีผู้รับไม่ตรงตาม tag แต่ตรงกับรายชื่อที่กำหนดเอง -> override เป็น "ตรง"');
                    statusReceiverName = 'ตรง';
                }
            } else {
                cLog.warn('เช็คชื่อบัญชีผู้รับที่กำหนดเอง: อ่านค่าชื่อบัญชีผู้รับไม่ได้ -> ไม่ override');
            }
        }

        // เช็คธนาคารผู้โอนไว้ล่วงหน้า
        const senderBankValues = getPopupRowValues('ธนาคารผู้โอน');
        const bankTexts = senderBankValues ? [senderBankValues.orderText, senderBankValues.slipText] : [];
        const matchedBankRule = detectBankRule(bankTexts);

        // ตรวจสอบเลขบัญชี + ชื่อผู้โอน (fuzzy) เมื่อสถานะ "ชื่อบัญชีผู้โอน" ไม่ตรง
        async function verifySenderWhenNameMismatch() {
            // เคสพิเศษ UOB (TMRW): ชื่อผู้โอนบนสลิปเป็น "TMRW" ทุกรายการ -> เทียบชื่อไม่ได้ ใช้เลขบัญชีอย่างเดียว
            const senderNameValuesAll = getPopupRowValues('ชื่อบัญชีผู้โอน');
            const isUobCase = !!(matchedBankRule && matchedBankRule.ignoreSenderName)
                || (!matchedBankRule && isTmrwSenderName(senderNameValuesAll));
            const activeRule = isUobCase ? (matchedBankRule || UOB_BANK_RULE) : matchedBankRule;
            let generalFuzzyResult = null;

            if (isUobCase) {
                if (!settings.enableUobNameBypass) {
                    cLog.warn('UOB (TMRW): ปิดโหมดข้ามการเทียบชื่อ -> ผู้โอนยังไม่ผ่านการยืนยัน');
                    return false;
                }
                cLog.step('UOB (TMRW): ชื่อผู้โอนบนสลิปเป็น "TMRW" ทุกรายการ -> ข้ามการเทียบชื่อ ใช้เลขบัญชีผู้โอนอย่างเดียว');
            } else {
                cLog.step('ชื่อบัญชีผู้โอนไม่ตรง -> ลองเช็คชื่อแบบ fuzzy ทั่วไปก่อน');
                if (settings.enableSenderNameFuzzyCheckGeneral) {
                    if (!generalFuzzyResult) {
                        generalFuzzyResult = await checkSenderNameFuzzyMatchGeneral(senderNameValuesAll);
                    }
                    if (generalFuzzyResult.isMatch) {
                        cLog.success('ชื่อผู้โอนคล้ายกันพอแล้ว (fuzzy ทั่วไป) -> ผู้โอนผ่านการยืนยันทันที');
                        return true;
                    }
                    cLog.info('ชื่อผู้โอนคล้ายกันไม่พอ (fuzzy ทั่วไป) -> ลองเช็คด้วยเลขบัญชีต่อ (bank map)');
                }
            }

            if (!settings.enableSenderAccountCheck) {
                cLog.warn('(ปิดฟังก์ชันเช็คเลขบัญชีผู้โอน -> ถือว่าผู้โอนยังไม่ผ่านการยืนยัน)');
                return false;
            }
            cLog.step('ตรวจสอบเพิ่มเติมที่เลขบัญชีผู้โอน (ตาม bank map)');
            const senderAccValues = getPopupRowValues('เลขบัญชีผู้โอน');
            const isDigitSequenceMatch = checkSenderAccountDigitSequence(senderAccValues, senderBankValues, activeRule);

            if (!isDigitSequenceMatch) {
                cLog.error('ไม่พบเลขบัญชีผู้โอนตรงตามตำแหน่งใน bank map -> ผู้โอนไม่ผ่านการยืนยัน');
                return false;
            }

            const needsNameFuzzyCheck = !!(activeRule && activeRule.requiresNameFuzzyCheck);
            if (needsNameFuzzyCheck && settings.enableSenderNameFuzzyCheck) {
                // ใช้ผล fuzzy รอบแรกซ้ำ ไม่ยิง Translation Server รอบสองโดยไม่จำเป็น
                let fuzzyResult = generalFuzzyResult;
                if (!fuzzyResult) {
                    cLog.step('ธนาคารนี้ต้องเช็คชื่อผู้โอนแบบ fuzzy เพิ่มเติมก่อนอนุมัติ');
                    const senderNameValues = getPopupRowValues('ชื่อบัญชีผู้โอน');
                    fuzzyResult = await checkSenderNameFuzzyMatch(senderNameValues);
                }

                if (!fuzzyResult.isMatch && !fuzzyResult.skipped) {
                    cLog.error('ชื่อผู้โอนไม่ผ่านเกณฑ์ fuzzy match -> ผู้โอนไม่ผ่านการยืนยัน');
                    return false;
                }
                if (fuzzyResult.skipped) {
                    cLog.warn('Translation Server/Google ไม่มีผลแปล -> ข้ามเฉพาะ Fuzzy ข้ามภาษา แต่ Bank Map ตรงแล้ว จึงผ่านขั้นตอนยืนยันผู้โอน');
                }
            }
            cLog.success('เลขบัญชีตรงตาม bank map -> ผู้โอนผ่านการยืนยัน');
            return true;
        }

        // เคสพิเศษ ธ.กรุงศรีอยุธยา: หน้าเว็บไม่มี tag ตรง/ไม่ตรง ให้สำหรับ "ชื่อบัญชีผู้รับ"
        const isKrungsriReceiverNameSpecialCase = !!(matchedBankRule && matchedBankRule.noReceiverNameTag) && statusReceiverName === null;

        // --- อนุมัติเมื่อเงื่อนไขย่อยผ่าน ---
        if (statusAmount === 'ตรง' && statusLast4 === 'ตรง' && statusReceiverName === 'ตรง' && statusSenderName === 'ตรง') {
            cLog.success('ข้อมูลตรงกันทั้ง 4 อย่าง -> อนุมัติทันที');
            cLog.groupEnd();
            await approveOrder();
        } else if (statusAmount === 'ตรง' && statusLast4 === 'ตรง' && statusReceiverName === 'ตรง' && statusSenderName === 'ไม่ตรง') {
            const senderVerified = await verifySenderWhenNameMismatch();
            if (!senderVerified) {
                cLog.groupEnd();
                await closePopup();
                return;
            }
            cLog.success('3 จุดแรกตรง และผู้โอนผ่านการยืนยันแล้ว -> อนุมัติทันที (เคสพิเศษ)');
            cLog.groupEnd();
            await approveOrder();
        } else if (isKrungsriReceiverNameSpecialCase && statusAmount === 'ตรง' && statusLast4 === 'ตรง') {
            cLog.info('ธนาคารกรุงศรีอยุธยา: ไม่มี tag เช็คชื่อบัญชีผู้รับ -> ใช้การเทียบชื่อที่ตั้งค่าไว้เอง');

            if (!settings.enableReceiverNameCustomCheck) {
                cLog.warn('(ปิดฟังก์ชันเช็คชื่อบัญชีผู้รับแบบกำหนดเอง -> ข้ามรายการนี้ไว้ให้เช็คเอง)');
                cLog.groupEnd();
                await closePopup();
                return;
            }

            const receiverNameValues = getPopupRowValues('ชื่อบัญชีผู้รับ');
            const isReceiverNameMatch = checkReceiverNameCustomMatch(receiverNameValues);
            if (!isReceiverNameMatch) {
                cLog.error('ชื่อบัญชีผู้รับไม่ตรงกับค่าที่กำหนดไว้ -> ข้ามรายการนี้');
                cLog.groupEnd();
                await closePopup();
                return;
            }

            let senderVerified = false;
            if (statusSenderName === 'ตรง') {
                senderVerified = true;
            } else if (statusSenderName === 'ไม่ตรง') {
                senderVerified = await verifySenderWhenNameMismatch();
            }

            if (!senderVerified) {
                cLog.error('ชื่อ/เลขบัญชีผู้โอนยังไม่ผ่านการยืนยัน -> ข้ามรายการนี้ (เคสพิเศษ กรุงศรีอยุธยา)');
                cLog.groupEnd();
                await closePopup();
                return;
            }

            cLog.success('ผ่านทุกเงื่อนไข -> อนุมัติทันที (เคสพิเศษ กรุงศรีอยุธยา)');
            cLog.groupEnd();
            await approveOrder();
        } else {
            cLog.warn('ข้อมูลไม่ตรงกัน -> ข้ามรายการนี้');
            cLog.groupEnd();
            await closePopup();
        }
    }

    // --- ฟังก์ชันสำหรับการ "อนุมัติ" ---
    async function tickCheckboxRobustly(checkbox) {
        if (checkbox.checked) return true;

        checkbox.click();
        await sleep(250);
        if (checkbox.checked) return true;

        try {
            const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'checked')?.set;
            if (nativeSetter) {
                nativeSetter.call(checkbox, true);
            } else {
                checkbox.checked = true;
            }
            checkbox.dispatchEvent(new Event('click', { bubbles: true }));
            checkbox.dispatchEvent(new Event('input', { bubbles: true }));
            checkbox.dispatchEvent(new Event('change', { bubbles: true }));
            await sleep(250);
            if (checkbox.checked) return true;
        } catch (e) {
            cLog.warn('ติ๊ก checkbox ด้วย native setter ไม่สำเร็จ: ' + e);
        }

        const parentLabel = checkbox.closest('label');
        if (parentLabel) {
            parentLabel.click();
            await sleep(250);
            if (checkbox.checked) return true;
        }

        return checkbox.checked === true;
    }

    async function checkApprovalWarningCheckboxIfPresent(timeout = 2000) {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            try {
                const labels = Array.from(document.querySelectorAll('label'))
                    .filter(el => isVisible(el) && el.textContent && el.textContent.includes('ตรวจสอบรูปสลิปแล้ว'));
                for (const label of labels) {
                    const checkbox = label.querySelector('input[type="checkbox"]');
                    if (checkbox && isVisible(checkbox)) {
                        if (!checkbox.checked) {
                            cLog.info('พบคำเตือนก่อนอนุมัติ -> ติ๊ก checkbox ยืนยันให้อัตโนมัติ');
                            await tickCheckboxRobustly(checkbox);
                        }
                        return true;
                    }
                }
            } catch (e) {
                cLog.warn('เช็ค/ติ๊ก checkbox ยืนยันก่อนอนุมัติ ไม่สำเร็จ: ' + e);
                return false;
            }
            await sleep(150);
        }
        return false;
    }

    async function approveOrder() {
        const approveBtn = await waitForButtonByText('อนุมัติ + Credit', 5000);
        if (!approveBtn) {
            recordTechnicalFailure('หาปุ่ม "อนุมัติ + Credit" ไม่เจอ');
            return false;
        }
        approveBtn.click();

        let confirmApproveBtn = await waitForButtonByText('ยืนยันการอนุมัติ', 5000);
        if (!confirmApproveBtn) {
            recordTechnicalFailure('หาปุ่ม "ยืนยันการอนุมัติ" ไม่เจอ');
            return false;
        }

        if (confirmApproveBtn.disabled) {
            const checkboxFound = await checkApprovalWarningCheckboxIfPresent();
            if (checkboxFound) {
                const pollStart = Date.now();
                while (Date.now() - pollStart < 3000) {
                    confirmApproveBtn = await waitForButtonByText('ยืนยันการอนุมัติ', 800) || confirmApproveBtn;
                    if (!confirmApproveBtn.disabled) break;
                    await sleep(200);
                }
            }
        }

        if (confirmApproveBtn.disabled) {
            recordTechnicalFailure('ปุ่ม "ยืนยันการอนุมัติ" ยัง disabled อยู่');
            return false;
        }
        confirmApproveBtn.click();
        cLog.success('อนุมัติสำเร็จเรียบร้อย');
        recordTechnicalSuccess();
        await sleep(350);
        return true;
    }

    function parseAmountText(text) {
        if (!text) return null;
        const cleaned = text.replace(/,/g, '');
        const found = cleaned.match(/-?\d+(\.\d+)?/);
        if (!found) return null;
        const num = parseFloat(found[0]);
        return Number.isNaN(num) ? null : num;
    }

    // ============================================================
    // Bank map & Rules  (v5.5: 1 ธนาคาร รองรับได้หลายรูปแบบตำแหน่ง)
    // ============================================================
    // สลิปของแต่ละธนาคาร (และแต่ละเวอร์ชันของแอป) แสดงเลขบัญชีผู้โอนไม่เหมือนกัน
    //   ตัวอย่าง ออมสิน 020242270252 (12 หลัก) บางสลิปขึ้น 2702 (ตำแหน่ง 7-10) บางสลิปขึ้น 0252 (4 ตัวท้าย)
    // จึงให้แต่ละธนาคารมี patterns ได้หลายแบบ -> "ตรงอย่างน้อย 1 แบบ" ถือว่าเลขบัญชีผ่าน
    //
    // pos = ตำแหน่งของเลขบัญชีที่นำมาต่อกันเป็นเลข 4 หลัก
    //   เลขบวก = นับจากหน้า (1 = หลักแรก) | เลขลบ = นับจากท้าย (-1 = หลักสุดท้าย)
    //   R(7, 10) = ตำแหน่ง 7,8,9,10  |  LAST4 = 4 ตัวท้าย  |  [4, 8, 9, 10] = หลักที่ 4 + หลักที่ 8-10
    //
    // อยากเพิ่มรูปแบบใหม่ของธนาคารไหน -> เพิ่มใน patterns ของธนาคารนั้นได้เลย เช่น patterns: [R(7, 10), LAST4, R(5, 8)]
    // (ดู Console: บรรทัด "💡 [Bank Map Hint]" จะบอกว่าเลข 4 หลักบนสลิปไปอยู่ตำแหน่งไหนของเลขบัญชีใน Order)
    const R = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
    const LAST4 = [-4, -3, -2, -1];
    const BBL_STYLE = [4, 8, 9, 10];

    // UOB / TMRW: สลิปขึ้นชื่อผู้โอนเป็น "TMRW" ทุกรายการ -> เทียบชื่อไม่ได้ (ignoreSenderName)
    // ** รูปแบบตำแหน่งของ UOB เป็นค่าที่คาดไว้ ควรเทียบกับสลิปจริงจาก Console (Bank Map Hint) **
    const UOB_BANK_RULE = {
        names: ['ยูโอบี', 'uob', 'united overseas', 'tmrw'],
        patterns: [R(7, 10), LAST4],
        ignoreSenderName: true,
        skipUniformMap: true
    };

    const BANK_RULES = [
        { names: ['เกียรตินาคินภัทร', 'kiatnakin', 'kkp'], patterns: [R(7, 10), LAST4] },
        { names: ['ออมสิน', 'government savings', 'gsb'], patterns: [R(7, 10), LAST4] },
        { names: ['ไทยพาณิชย์', 'siam commercial', 'scb'], patterns: [R(7, 10), LAST4] },
        { names: ['ทหารไทยธนชาต', 'ทีเอ็มบีธนชาต', 'ttb', 'tmbthanachart', 'tmb thanachart'], patterns: [R(7, 10), LAST4] },
        { names: ['กรุงไทย', 'krungthai', 'ktb'], patterns: [R(7, 10), LAST4] },
        { names: ['เพื่อการเกษตรและสหกรณ์', 'ธ.ก.ส', 'baac'], patterns: [R(7, 10), LAST4] },
        // กรุงศรี: สลิปแสดงได้หลายตำแหน่ง (5-8 / 6-9 / 7-10 / 4 ตัวท้าย / แบบ BBL) + ต้องผ่านเช็คชื่อ fuzzy เพิ่ม
        { names: ['กรุงศรีอยุธยา', 'krungsri', 'bank of ayudhya', 'ayudhya', 'bay'], patterns: [R(5, 8), R(6, 9), R(7, 10), LAST4, BBL_STYLE], requiresNameFuzzyCheck: true, noReceiverNameTag: true, skipUniformMap: true },
        { names: ['กสิกรไทย', 'kasikorn', 'kbank'], patterns: [R(6, 9), LAST4] },
        // กรุงเทพ: เลขที่โชว์กระจายหลายตำแหน่ง (หลักที่ 4 + 8-10) + ต้องผ่านเช็คชื่อ fuzzy เพิ่ม
        { names: ['กรุงเทพ', 'bangkok bank', 'bbl'], patterns: [BBL_STYLE, LAST4], requiresNameFuzzyCheck: true, skipUniformMap: true },
        UOB_BANK_RULE,
    ];

    function detectBankRule(bankTexts) {
        const combined = (bankTexts || []).filter(Boolean).join(' ').toLowerCase();
        if (!combined) return null;
        for (const rule of BANK_RULES) {
            if (rule.names.some(name => combined.includes(name.toLowerCase()))) {
                return rule;
            }
        }
        return null;
    }

    // ดึงเลขตามตำแหน่ง (ตำแหน่งนับจาก 1, ค่าลบนับจากท้าย) -> null ถ้าเลขบัญชีสั้นเกินตำแหน่งที่ต้องการ
    function extractByPositions(longNum, positions) {
        const len = longNum.length;
        let out = '';
        for (const p of positions) {
            const idx = p > 0 ? p - 1 : len + p;
            if (idx < 0 || idx >= len) return null;
            out += longNum[idx];
        }
        return out;
    }

    function describePositions(pos) {
        const contiguous = pos.every((p, i) => i === 0 || p === pos[i - 1] + 1);
        if (contiguous && pos.every(p => p < 0) && pos[pos.length - 1] === -1) return `${pos.length} ตัวท้าย`;
        if (contiguous) return `${pos[0]}-${pos[pos.length - 1]}`;
        return pos.join(',');
    }

    // เทียบเลข 4 หลักบนสลิป กับทุก pattern ของธนาคาร (ตรงอย่างน้อย 1 แบบ = ผ่าน)
    // คืน { isMatch, extracted, matchedLabel, tried:[{extracted, labels:[]}] }
    function matchByPatterns(shortNum, longNum, rule) {
        const tried = [];
        if (!shortNum || !longNum || !rule || !Array.isArray(rule.patterns)) {
            return { isMatch: false, extracted: '', matchedLabel: '', tried };
        }
        for (const p of rule.patterns) {
            const pos = Array.isArray(p) ? p : p.pos;
            const label = (!Array.isArray(p) && p.label) || describePositions(pos);
            const extracted = extractByPositions(longNum, pos);
            if (extracted === null || extracted.length !== shortNum.length) continue;
            const existing = tried.find(t => t.extracted === extracted);
            if (existing) existing.labels.push(label);          // หลายแบบได้เลขชุดเดียวกัน (เช่น 7-10 กับ 4 ตัวท้ายของเลข 10 หลัก)
            else tried.push({ extracted, labels: [label] });
        }
        const hit = tried.find(t => t.extracted === shortNum);
        return {
            isMatch: !!hit,
            extracted: hit ? hit.extracted : (tried[0] ? tried[0].extracted : ''),
            matchedLabel: hit ? hit.labels.join(' / ') : '',
            tried
        };
    }

    // โหมด Dynamic Length-Based (enableUniformBankMap): เลข 4 หลักต้องอยู่ในช่วงตำแหน่งที่กำหนด (10 หลัก = 5-10, 12 หลัก = 6-12)
    function matchByWindow(shortNum, longNum, startPos, endPos) {
        if (!shortNum || !longNum || longNum.length < endPos) return { isMatch: false, extracted: '', matchedLabel: '', tried: [] };
        const segment = longNum.slice(startPos - 1, endPos);
        const isMatch = segment.length >= shortNum.length && segment.includes(shortNum);
        return {
            isMatch,
            extracted: segment,
            matchedLabel: isMatch ? `ช่วง ${startPos}-${endPos}` : '',
            tried: [{ extracted: segment, labels: [`ช่วง ${startPos}-${endPos}`] }]
        };
    }

    // หาว่าเลข 4 หลักบนสลิปไปอยู่ตำแหน่งไหนของเลขบัญชีใน Order (ไว้ช่วยดูว่าธนาคารนั้นใช้รูปแบบอะไร)
    function findDigitWindowPositions(shortNum, longNum) {
        const hits = [];
        for (let i = 0; i + shortNum.length <= longNum.length; i++) {
            if (longNum.substr(i, shortNum.length) === shortNum) {
                const from = i + 1, to = i + shortNum.length;
                hits.push(to === longNum.length ? `${from}-${to} (4 ตัวท้าย)` : `${from}-${to}`);
            }
        }
        return hits;
    }

    // สลิป UOB (TMRW) ขึ้นชื่อผู้โอนเป็น "TMRW"
    function isTmrwName(text) {
        return /(^|[^A-Za-z])TMRW([^A-Za-z]|$)/i.test(String(text || ''));
    }
    function isTmrwSenderName(senderNameValues) {
        if (!senderNameValues) return false;
        return isTmrwName(senderNameValues.slipText) || isTmrwName(senderNameValues.orderText);
    }

    // ============================================================
    // ชื่อบัญชีผู้รับที่กำหนดเอง
    // ============================================================
    function normalizeReceiverName(value) {
        return (value || '')
            .normalize('NFKC')
            .toLocaleUpperCase()
            // ตัดช่องว่างและเครื่องหมายวรรคตอนออก เพื่อรองรับ OCR ที่เว้นวรรค/อ่านจุด/จุลภาคต่างกัน
            .replace(/[^\p{L}\p{N}]/gu, '');
    }

    function checkReceiverNameCustomMatch(receiverNameValues) {
        const configuredList = parseCustomReceiverNameList(loadCustomReceiverName());
        if (configuredList.length === 0) {
            cLog.warn('ยังไม่ได้กำหนดรายชื่อบัญชีผู้รับที่ใช้ตรวจสอบ');
            return false;
        }
        if (!receiverNameValues || !receiverNameValues.slipText) {
            cLog.warn('อ่านชื่อบัญชีผู้รับจากฝั่งสลิปไม่ได้');
            return false;
        }

        const slipValue = receiverNameValues.slipText.trim();
        const normalizedSlip = normalizeReceiverName(slipValue);
        const matchedName = configuredList.find(name =>
            normalizeReceiverName(name) === normalizedSlip
        );
        const isMatch = !!normalizedSlip && !!matchedName;

        cLog.info(
            `เช็คชื่อบัญชีผู้รับที่กำหนดเอง: ฝั่งสลิป "${slipValue}" ` +
            `เทียบ ${configuredList.length} รายชื่อ -> ${isMatch ? `ตรงกับ "${matchedName}"` : 'ไม่ตรง'}`
        );
        return isMatch;
    }

    // ============================================================
    // last4 ที่กำหนดเอง
    // ============================================================
    function checkCustomLast4Match(last4Values) {
        const configuredList = parseCustomLast4List(loadCustomLast4Raw());
        if (configuredList.length === 0) return false;
        if (!last4Values || !last4Values.slipText) return false;

        const slip4Digits = (last4Values.slipText.match(/\d+/g) || []).filter(g => g.length === 4);
        if (slip4Digits.length === 0) return false;

        const isMatch = slip4Digits.some(d => configuredList.includes(d));
        cLog.info(`เช็ค last4 ที่กำหนดเอง: ฝั่งสลิป [${slip4Digits.join(', ')}] เทียบกับค่าที่กำหนด -> ${isMatch ? 'ตรง' : 'ไม่ตรง'}`);
        return isMatch;
    }

    function checkSenderAccountDigitSequence(accountValues, bankValues, ruleOverride) {
        if (!accountValues) return false;

        const slipGroups = accountValues.slipText.match(/\d+/g) || [];
        const orderGroups = accountValues.orderText.match(/\d+/g) || [];

        const shortNums = slipGroups.filter(g => g.length === 4);
        const longNums = orderGroups.filter(g => g.length === 10 || g.length === 12);

        if (shortNums.length === 0 || longNums.length === 0) return false;

        const bankTexts = bankValues ? [bankValues.orderText, bankValues.slipText] : [];
        const rule = ruleOverride || detectBankRule(bankTexts);

        if (!rule) {
            cLog.warn(`📍 [Bank Map] ไม่รู้จักธนาคารผู้โอน (ข้อความธนาคาร: ${bankTexts.filter(Boolean).join(' | ') || '-'}) -> ไม่มีกฎใน BANK_RULES จึงเช็คเลขบัญชีไม่ได้`);
            return false;
        }
        const bankLabel = rule.names[0];

        const useUniformMap = settings.enableUniformBankMap && !rule.skipUniformMap;

        for (const shortNum of shortNums) {
            for (const longNum of longNums) {
                let matchResult;
                if (useUniformMap) {
                    matchResult = longNum.length === 10
                        ? matchByWindow(shortNum, longNum, 5, 10)
                        : matchByWindow(shortNum, longNum, 6, 12);
                } else {
                    matchResult = matchByPatterns(shortNum, longNum, rule);
                }

                // --- 📌 Log แสดงการดึงตำแหน่งเลขบัญชีเทียบกับสลิป ---
                if (matchResult.isMatch) {
                    cLog.info(`📍 [Bank Map Match] ธนาคาร ${bankLabel} | เลข Order: ${longNum} -> ตรงแบบ [${matchResult.matchedLabel}] = "${shortNum}" == สลิป 4 ตัวท้าย: "${shortNum}" [ตรงกัน 100%]`);
                    return true;
                }

                const triedText = matchResult.tried.length
                    ? matchResult.tried.map(t => `${t.labels.join('/')}="${t.extracted}"`).join(', ')
                    : 'N/A';
                cLog.info(`📍 [Bank Map Check] ธนาคาร ${bankLabel} | เลข Order: ${longNum} -> ลองแล้ว: ${triedText} != สลิป: "${shortNum}" [ไม่ตรง]`);
                const hits = findDigitWindowPositions(shortNum, longNum);
                if (hits.length) {
                    cLog.info(`💡 [Bank Map Hint] เลขสลิป "${shortNum}" ไปอยู่ตำแหน่ง ${hits.join(' หรือ ')} ของเลข Order ${longNum} (ธนาคาร ${bankLabel}) -> ถ้าธนาคารนี้เจอรูปแบบนี้ซ้ำ ๆ ให้เพิ่มใน patterns ของ BANK_RULES`);
                }
            }
        }
        return false;
    }

    // ============================================================
    // เช็คชื่อผู้โอนแบบ fuzzy match (รองรับ ไทย<->อังกฤษ ทั้งสองทิศทาง)
    // - เทียบเฉพาะ "ชื่อจริงคำแรก" (ตัดคำนำหน้า + นามสกุลทิ้ง)
    // - ชื่อภาษาเดียวกัน: เทียบตรง ๆ ไม่ต้องแปล
    // - ชื่อต่างภาษา: แปลฝั่งไทยเป็นอังกฤษผ่าน server (/translate) แล้วเทียบ
    // ============================================================
    const TRANSLATE_API_URL = 'http://127.0.0.1:5001/translate';
    const NAME_FUZZY_MATCH_THRESHOLD = 50;          // ต่างภาษา: ผ่านเมื่อความคล้ายตั้งแต่ 50%
    const NAME_FUZZY_MATCH_THRESHOLD_GENERAL = 50;  // ภาษาเดียวกัน: ผ่านเมื่อความคล้ายตั้งแต่ 50%
    const NAME_SHORT_LENGTH = 4;                    // ชื่อสั้นก็ใช้เกณฑ์ 50% ตามที่กำหนด
    const NAME_SHORT_THRESHOLD = 50;
    const NAME_REVIEW_PERCENT = 70;                 // ข้ามภาษา "ผ่าน" แต่ความเหมือนต่ำกว่า 70% -> บันทึกลง unmatched_names.txt ให้ตรวจ (ไม่กระทบผลอนุมัติ)
    const _nameTranslationCache = new Map();        // cache เฉพาะผลที่แปลสำเร็จ (ล้มเหลวจะลองใหม่รอบหน้า)
    const _nameTranslationInFlight = new Map();     // รวม request ชื่อซ้ำที่กำลังแปล

    // เรียก server /translate -> คืน object ผลลัพธ์ หรือ null ถ้าติดต่อไม่ได้/ตอบผิดรูปแบบ
    function requestNameTranslation(name, extraQuery = '') {
        const url = `${TRANSLATE_API_URL}?name=${encodeURIComponent(name)}${extraQuery}`;
        const parse = (text) => {
            try { return JSON.parse(text); } catch (e) { return null; }
        };
        return new Promise((resolve) => {
            if (typeof GM_xmlhttpRequest === 'function') {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url,
                    timeout: 20000,
                    onload: (res) => {
                        if (res.status !== 200) { cLog.warn(`🔤 [Translate API] server ตอบ HTTP ${res.status}`); return resolve(null); }
                        resolve(parse(res.responseText));
                    },
                    onerror: () => { cLog.warn('🔤 [Translate API] ติดต่อ server ไม่ได้ (server ไม่ได้รัน / พอร์ต 5001 / ถูกบล็อก)'); resolve(null); },
                    ontimeout: () => { cLog.warn('🔤 [Translate API] server ตอบช้าเกิน 20 วินาที (timeout)'); resolve(null); }
                });
            } else {
                fetch(url)
                    .then(r => r.json())
                    .then(data => resolve(data || null))
                    .catch(() => resolve(null));
            }
        });
    }

    // รายงานชื่อข้ามภาษาให้ server บันทึกลง unmatched_names.txt (รูปแบบ  ชื่อไทย = ชื่ออังกฤษ)
    //  - เทียบไม่ผ่าน/แปลไม่ได้   - หรือ "ผ่านแต่ความเหมือนต่ำกว่า NAME_REVIEW_PERCENT (70%)"
    // ชื่อซ้ำไม่ลงซ้ำ: กันซ้ำที่ฝั่งนี้ (ต่อรอบที่เปิดหน้าเว็บ) และที่ server (เทียบกับไฟล์จริง + name_overrides.txt)
    // note ใช้แสดงใน console เท่านั้น ไม่ถูกเขียนลงไฟล์
    const _reportedUnmatched = new Set();
    async function reportUnmatchedName(thaiFirst, enFirst, note = '') {
        let key = null;
        try {
            if (!thaiFirst || !enFirst) return;
            key = thaiFirst + '|' + String(enFirst).toUpperCase().replace(/[^A-Z]/g, '');
            if (_reportedUnmatched.has(key)) return;
            _reportedUnmatched.add(key);
            const url = `${TRANSLATE_API_URL.replace(/\/translate$/, '/unmatched')}?th=${encodeURIComponent(thaiFirst)}&en=${encodeURIComponent(enFirst)}&note=${encodeURIComponent(note)}`;
            const data = await new Promise((resolve) => {
                if (typeof GM_xmlhttpRequest === 'function') {
                    GM_xmlhttpRequest({
                        method: 'GET', url, timeout: 10000,
                        onload: (res) => { try { resolve(res.status === 200 ? JSON.parse(res.responseText) : null); } catch (e) { resolve(null); } },
                        onerror: () => resolve(null),
                        ontimeout: () => resolve(null)
                    });
                } else {
                    fetch(url).then(r => r.json()).then(d => resolve(d || null)).catch(() => resolve(null));
                }
            });
            if (!data) { _reportedUnmatched.delete(key); return; }   // server ไม่ตอบ -> ยังไม่นับว่ารายงานแล้ว รอบหน้าลองใหม่
            if (data.recorded) cLog.info(`📝 [Unmatched] บันทึกลง unmatched_names.txt${note ? ` (${note})` : ''}: ${data.line}`);
        } catch (e) { if (key) _reportedUnmatched.delete(key); /* การบันทึกต้องไม่กระทบการตัดสินใจหลัก */ }
    }

    // แปล "ชื่อจริงภาษาไทย" -> { variants: [สะกดอังกฤษ ตัวพิมพ์ใหญ่], engine } ; variants = [] ถ้าแปลไม่ได้ (ไม่เดา/ไม่ปลอมผลแปล)
    async function translateThaiFirstNameInfo(thaiFirstName) {
        const key = 'th2en:' + thaiFirstName;
        if (_nameTranslationCache.has(key)) return _nameTranslationCache.get(key);
        if (_nameTranslationInFlight.has(key)) return _nameTranslationInFlight.get(key);
        const pending = (async () => {
        const data = await requestNameTranslation(thaiFirstName, '&firstOnly=1');
        let variants = [];
        if (data && !data.failed) {
            const raw = Array.isArray(data.variants) && data.variants.length ? data.variants : [data.translated];
            variants = raw
                .filter(v => typeof v === 'string' && v && !/[\u0E00-\u0E7F]/.test(v))   // ต้องเป็นอังกฤษจริง
                .map(v => v.toUpperCase());
        }
        const info = {
            variants,
            engine: (data && data.engine) || 'none',
            serverResponded: !!data,
            translationFailed: !data || data.failed === true
        };
        if (variants.length) _nameTranslationCache.set(key, info);
        return info;
        })();
        _nameTranslationInFlight.set(key, pending);
        try { return await pending; }
        finally { _nameTranslationInFlight.delete(key); }
    }

    async function translateThaiFirstNameVariants(thaiFirstName) {
        return (await translateThaiFirstNameInfo(thaiFirstName)).variants;
    }

    // ชื่อสำหรับตัวเดิม: คืนสะกดอังกฤษหลักของ "ชื่อจริง" (null ถ้าแปลไม่ได้) -- รับชื่อเต็ม/มีคำนำหน้าได้
    async function translateThaiNameToEnglish(thaiName) {
        const info = getFirstNameInfo(thaiName);
        if (!info.first || info.lang !== 'TH') return null;
        const variants = await translateThaiFirstNameVariants(info.first);
        return variants.length ? variants[0] : null;
    }

    // EN -> TH: ใช้เฉพาะผลจาก dictionary (name_overrides.txt) ที่ server ยืนยันว่า reliable เท่านั้น
    async function translateEnglishFirstNameToThaiDictionary(enFirstName) {
        const key = 'en2th:' + enFirstName.toUpperCase();
        if (_nameTranslationCache.has(key)) return _nameTranslationCache.get(key);
        if (_nameTranslationInFlight.has(key)) return _nameTranslationInFlight.get(key);
        const pending = (async () => {
        const data = await requestNameTranslation(enFirstName, '&firstOnly=1&dictionaryOnly=1');
        let variants = [];
        if (data && data.direction === 'EN_TO_TH' && data.reliable === true && !data.failed) {
            variants = (Array.isArray(data.variants) ? data.variants : [])
                .filter(v => typeof v === 'string' && /[\u0E00-\u0E7F]/.test(v));
        }
        if (variants.length) _nameTranslationCache.set(key, variants);
        return variants;
        })();
        _nameTranslationInFlight.set(key, pending);
        try { return await pending; }
        finally { _nameTranslationInFlight.delete(key); }
    }

    function levenshteinDistance(a, b) {
        const m = a.length, n = b.length;
        if (m === 0) return n;
        if (n === 0) return m;
        const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
        for (let i = 0; i <= m; i++) dp[i][0] = i;
        for (let j = 0; j <= n; j++) dp[0][j] = j;
        for (let i = 1; i <= m; i++) {
            for (let j = 1; j <= n; j++) {
                if (a[i - 1] === b[j - 1]) {
                    dp[i][j] = dp[i - 1][j - 1];
                } else {
                    dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
                }
            }
        }
        return dp[m][n];
    }

    // รวมการสะกดอังกฤษที่ต่างกันตามระบบถอดเสียง (ต้องตรงกับ canonicalizeEnName ใน server.js)
    function canonicalizeEnName(s) {
        let t = String(s || '').toUpperCase().replace(/[^A-Z]/g, '');
        t = t.replace(/PH/g, 'P').replace(/TH/g, 'T').replace(/KH/g, 'K').replace(/GH/g, 'G')
             .replace(/CH/g, 'J').replace(/OO/g, 'U').replace(/EE/g, 'I').replace(/AA/g, 'A')
             .replace(/[CQ]/g, 'K').replace(/Y/g, 'I').replace(/V/g, 'W').replace(/H/g, '')
             .replace(/RN/g, 'N').replace(/L$/, 'N').replace(/(.)\1+/g, '$1');
        return t;
    }

    // ความเหมือนชื่ออังกฤษ (0-100) = ค่าสูงสุดระหว่างเทียบตรง กับเทียบหลังรวมการสะกด
    function fuzzyMatchPercent(nameA, nameB) {
        const ra = String(nameA || '').toUpperCase().replace(/[^A-Z]/g, '');
        const rb = String(nameB || '').toUpperCase().replace(/[^A-Z]/g, '');
        if (!ra || !rb) return 0;
        const raw = (1 - levenshteinDistance(ra, rb) / Math.max(ra.length, rb.length)) * 100;
        const ca = canonicalizeEnName(ra), cb = canonicalizeEnName(rb);
        const canon = (ca && cb) ? (1 - levenshteinDistance(ca, cb) / Math.max(ca.length, cb.length)) * 100 : 0;
        let score = Math.max(0, raw, canon);
        // ชื่อจริง+นามสกุลที่เขียนติดกัน: ชื่อสั้นเป็น "ส่วนหน้า" ของชื่อยาว (>= 5 ตัวอักษร) -> ใกล้เคียงมาก (ต้องตรงกับ server.js)
        if (ca && cb) {
            const [shortC, longC] = ca.length <= cb.length ? [ca, cb] : [cb, ca];
            if (shortC.length >= 5 && shortC.length < longC.length && longC.startsWith(shortC)) score = Math.max(score, 75);
        }
        // ตัวอักษรแรกต้องสอดคล้องกัน (กลุ่มเสียงใกล้กัน) ไม่งั้นถือว่าคนละชื่อ (ต้องตรงกับ enNameSimilarity ใน server.js)
        if (!firstLettersCompatible(ca || ra, cb || rb)) return Math.min(score, 49);
        return score;
    }

    const FIRST_LETTER_GROUPS = ['TD', 'BP', 'KG', 'LR', 'WV', 'AEIOU'];
    function firstLettersCompatible(canonA, canonB) {
        const x = canonA[0], y = canonB[0];
        if (!x || !y) return false;
        if (x === y) return true;
        return FIRST_LETTER_GROUPS.some(g => g.includes(x) && g.includes(y));
    }

    function normalizeThaiNameForCompare(s) {
        return String(s || '')
            .replace(/เเ/g, 'แ')                    // พิมพ์ เ สองตัวแทน แ
            .replace(/[\u0E48-\u0E4C\u0E46]/g, '')   // วรรณยุกต์ ทัณฑฆาต ไม้ยมก
            .replace(/[^\u0E00-\u0E7F]/g, '');
    }

    function thaiNameSimilarityPercent(a, b) {
        const ta = normalizeThaiNameForCompare(a), tb = normalizeThaiNameForCompare(b);
        if (!ta || !tb) return 0;
        return Math.max(0, (1 - levenshteinDistance(ta, tb) / Math.max(ta.length, tb.length)) * 100);
    }

    // ---------- แยกชื่อ: ตัดคำนำหน้า (ไทย/อังกฤษ) + นามสกุล เหลือชื่อจริงคำแรก ----------
    // คำนำหน้าไทยที่ชัดเจน (ติดกับชื่อได้ เช่น "นายสมชาย", "น.ส.ปภาดา")
    const THAI_TITLE_PREFIXES_REGEX = /^(เด็กหญิง|เด็กชาย|นางสาว|น\.\s?ส\.?|ด\.\s?ช\.?|ด\.\s?ญ\.?|นาย|นาง)\s*/;
    // คำนำหน้าที่กำกวม (อาจเป็นต้นชื่อจริง เช่น "คุณากร") ต้องมีจุดหรือเว้นวรรคตามหลัง
    const THAI_TITLE_AMBIGUOUS_REGEX = /^(นส|ดช|ดญ|ดร|คุณ)(?:\.\s*|\s+)/;
    const EN_TITLE_PREFIX_REGEX = /^(MRS|MR|MS|MISS|MASTER|MSTR|DR|PROF|KHUN)(?:\.\s*|\s+)/i;
    const EN_TITLE_ONLY_REGEX = /^(MRS|MR|MS|MISS|MASTER|MSTR|DR|PROF|KHUN)\.?$/i;
    // ยศ/คำนำหน้าอื่น ๆ ที่พบบนสลิป (ต้องตรงกับ server.js)
    const THAI_TITLE_MIL_REGEX = /^ว่าที่\s?(?:(?:ร้อย|พัน)(?:ตรี|โท|เอก)|ร\.?[ตทอ]\.?|พ\.?[ตทอ]\.?)(?:\s?หญิง)?\s*/;
    const THAI_TITLE_DOTTED_REGEX = /^(?:(?:[ก-ฮ]\.){2,4}|(?:ดร|ผศ|รศ|ศ|นพ|พญ|ทพ|ภก|ภญ)\.)\s*(?=[ก-ฮเ-ไ])/;
    const EN_TITLE_MIL_REGEX = /^(?:ACTING\s+)?(?:(?:POL\.?\s*)?(?:GEN|COL|LT|CAPT|MAJ|SGT)|SUB\s*LT|ASST?\.?\s*PROF|ASSOC\.?\s*PROF|REV)(?:\.\s*|\s+)/i;
    const EN_TITLE_TRAILING_REGEX = /\s+(MRS|MR|MS|MISS)\.?$/i;   // เช่น "PRAASAN PROMMEEDET MR"
    // คำนำหน้าแบบถอดเสียงไทยเป็นอังกฤษ (เช่น "NAI SOMCHAI") -- ไม่ใส่ KUN เพราะ "ขุน" = KUN เป็นชื่อจริงได้
    const NAME_TITLE_PREFIXES = [
        'mr', 'mrs', 'miss', 'ms', 'mstr', 'master', 'dr', 'prof',
        'nai', 'naiy', 'nay', 'nang', 'nangsao', 'nangsaw', 'khun'
    ];

    function normalizeNameSpaces(text) {
        return String(text || '')
            .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')   // zero-width ที่ติดมาจากการ copy
            .replace(/\s+/g, ' ')
            .trim();
    }

    function stripNameTitles(text) {
        let s = normalizeNameSpaces(String(text || '').replace(/\([^)]*\)/g, ' '));   // ตัดข้อความในวงเล็บ เช่น "(ธนาคารกสิกรไทย)"
        for (let i = 0; i < 5; i++) {
            const before = s;
            let m;
            if ((m = s.match(THAI_TITLE_PREFIXES_REGEX)) || (m = s.match(THAI_TITLE_AMBIGUOUS_REGEX))) {
                s = s.slice(m[0].length).trim();
            } else if ((m = s.match(EN_TITLE_PREFIX_REGEX))) {
                s = s.slice(m[0].length).trim();
            } else if ((m = s.match(THAI_TITLE_MIL_REGEX)) || (m = s.match(THAI_TITLE_DOTTED_REGEX))) {
                s = s.slice(m[0].length).trim();
            } else if ((m = s.match(EN_TITLE_MIL_REGEX))) {
                s = s.slice(m[0].length).trim();
            } else if (EN_TITLE_ONLY_REGEX.test(s)) {
                s = '';
            }
            if (s === before) break;
        }
        if (s.includes(' ')) s = s.replace(EN_TITLE_TRAILING_REGEX, '').trim();
        return s;
    }

    // คงชื่อเดิมไว้ใช้งาน: ตัดคำนำหน้าไทยออกจากชื่อเต็ม (ตอนนี้ตัดอังกฤษด้วย)
    function stripThaiTitlePrefix(fullNameTh) {
        if (!fullNameTh) return fullNameTh;
        return stripNameTitles(fullNameTh);
    }

    // คงชื่อเดิม: ดึงชื่อจริงคำแรก (ข้ามคำนำหน้าไทย/อังกฤษ/ถอดเสียง)
    function extractFirstName(fullName) {
        if (!fullName) return '';
        const words = stripNameTitles(fullName).split(' ').filter(Boolean);
        let idx = 0;
        while (idx < words.length - 1) {
            const wordClean = words[idx].replace(/\./g, '').toLowerCase();
            if (NAME_TITLE_PREFIXES.includes(wordClean)) idx++;
            else break;
        }
        let first = '';
        for (let i = idx; i < words.length; i++) {
            if (/[A-Za-z\u0E00-\u0E7F]/.test(words[i])) { first = words[i]; break; }
        }
        return first.replace(/^[^A-Za-z\u0E00-\u0E7F]+|[^A-Za-z\u0E00-\u0E7F]+$/g, '');
    }

    // { first, lang: 'TH' | 'EN' | 'NONE' }
    function getFirstNameInfo(fullName) {
        const first = extractFirstName(fullName);
        const lang = !first ? 'NONE' : (/[\u0E00-\u0E7F]/.test(first) ? 'TH' : 'EN');
        return { first, lang };
    }

    function shortNameThreshold(base, len) {
        return (len > 0 && len <= NAME_SHORT_LENGTH) ? Math.max(base, NAME_SHORT_THRESHOLD) : base;
    }

    // เช็คเร็วแบบไม่ต้องเรียก server: ใช้ได้เมื่อ 2 ฝั่งเป็นภาษาเดียวกัน (ไทย-ไทย / อังกฤษ-อังกฤษ)
    // ถ้าต่างภาษา -> คืน needsTranslation:true ให้ฝั่งเรียกไปใช้ checkSenderNameFuzzyMatch (async)
    function checkSenderNameFuzzyMatchThai(senderNameValues) {
        if (!senderNameValues) return { isMatch: false, percent: 0 };
        const a = getFirstNameInfo(senderNameValues.orderText);
        const b = getFirstNameInfo(senderNameValues.slipText);
        if (!a.first || !b.first) return { isMatch: false, percent: 0 };

        if (a.lang !== b.lang) {
            return { isMatch: false, percent: 0, needsTranslation: true };
        }

        let percent, len, label;
        if (a.lang === 'TH') {
            percent = Math.round(thaiNameSimilarityPercent(a.first, b.first));
            len = Math.min(normalizeThaiNameForCompare(a.first).length, normalizeThaiNameForCompare(b.first).length) + 1;
            label = 'TH';
        } else {
            percent = Math.round(fuzzyMatchPercent(a.first, b.first));
            len = Math.min(a.first.replace(/[^A-Za-z]/g, '').length, b.first.replace(/[^A-Za-z]/g, '').length);
            label = 'EN';
        }
        const thr = shortNameThreshold(NAME_FUZZY_MATCH_THRESHOLD_GENERAL, len);
        const isMatch = percent >= thr;

        // --- 📌 Log แสดงการเทียบชื่อจริง (ภาษาเดียวกัน) ---
        cLog.info(`🔤 [Fuzzy Match ${label}] ชื่อจริง Order: "${a.first}" <==> สลิป: "${b.first}" -> ความเหมือน ${percent}% (เกณฑ์ ${thr}%) [${isMatch ? 'ผ่าน' : 'ไม่ผ่าน'}]`);
        return { isMatch, percent };
    }

    // เทียบชื่อจริงรองรับทุกทิศทาง (TH<->EN) ; ฝั่งต่างภาษาจะแปลผ่าน server  ** ต้อง await เสมอ **
    async function checkSenderNameFuzzyMatch(senderNameValues) {
        if (!senderNameValues) return { isMatch: false, percent: 0, translatedName: null };

        // ชื่อ "TMRW" (UOB) ไม่ใช่ชื่อคน -> ไม่เทียบ/ไม่แปล/ไม่รายงานลง unmatched_names.txt
        if (isTmrwSenderName(senderNameValues)) {
            cLog.info('🔤 [Name Check] ชื่อผู้โอนเป็น "TMRW" (UOB) ไม่ใช่ชื่อคน -> ข้ามการเทียบชื่อ');
            return { isMatch: false, percent: 0, translatedName: null, reason: 'tmrw' };
        }

        const order = getFirstNameInfo(senderNameValues.orderText);
        const slip = getFirstNameInfo(senderNameValues.slipText);
        if (!order.first || !slip.first) {
            cLog.warn(`🔤 [Name Check] ไม่พบชื่อจริงให้เทียบหลังตัดคำนำหน้า (Order: "${senderNameValues.orderText}" / สลิป: "${senderNameValues.slipText}")`);
            return { isMatch: false, percent: 0, translatedName: null };
        }

        // ภาษาเดียวกัน -> เทียบตรง ไม่ต้องแปล (ไม่แปลซ้ำโดยไม่จำเป็น)
        if (order.lang === slip.lang) {
            const r = checkSenderNameFuzzyMatchThai(senderNameValues);
            return { isMatch: r.isMatch, percent: r.percent, translatedName: null };
        }

        // ต่างภาษา -> แปลฝั่งไทยเป็นอังกฤษก่อน (ไทย->อังกฤษ) แล้วเทียบกับชื่ออังกฤษอีกฝั่ง
        const thaiSide = order.lang === 'TH' ? order : slip;
        const enSide = order.lang === 'TH' ? slip : order;
        const directionLabel = order.lang === 'TH' ? 'Order(TH) -> สลิป(EN)' : 'Order(EN) <- สลิป(TH)';

        const [thInfo, thaiFromDict] = await Promise.all([
            translateThaiFirstNameInfo(thaiSide.first),
            translateEnglishFirstNameToThaiDictionary(enSide.first)
        ]);
        const variants = thInfo.variants;
        let percent = 0;
        let bestCandidate = null;
        let enLen = 0;
        for (const v of variants) {
            const p = fuzzyMatchPercent(v, enSide.first);
            if (p > percent) {
                percent = p;
                bestCandidate = v;
                enLen = Math.min(v.replace(/[^A-Z]/g, '').length, enSide.first.replace(/[^A-Za-z]/g, '').length);
            }
        }

        // EN -> TH : ใช้ dictionary ที่ server ยืนยันว่าเชื่อถือได้เท่านั้น แล้วเทียบเป็นภาษาไทยกับชื่อไทยอีกฝั่ง
        // EN -> TH dictionary ถูกเตรียมพร้อมขนานกับ TH -> EN แล้ว
        let thaiPercent = 0;
        let thaiBest = null;
        for (const t of thaiFromDict) {
            const p = thaiNameSimilarityPercent(t, thaiSide.first);
            if (p > thaiPercent) { thaiPercent = p; thaiBest = t; }
        }

        // ชื่อไทยอยู่ใน dictionary และชื่ออังกฤษเป็นการสะกดของ "ชื่อไทยอีกชื่อหนึ่ง" (เช่น SOMCHAI vs SOMMAI) -> คนละชื่อ
        if (thInfo.engine === 'dictionary' && thaiFromDict.length) {
            const nt = normalizeThaiNameForCompare(thaiSide.first);
            if (!thaiFromDict.some(t => normalizeThaiNameForCompare(t) === nt)) {
                cLog.info(`🔤 [Translate & Fuzzy] "${thaiSide.first}" กับ "${enSide.first}" เป็นคนละชื่อใน dictionary -> ไม่ผ่าน`);
                return { isMatch: false, percent: 0, translatedName: thInfo.variants[0] || null, reason: 'known_different', candidates: thInfo.variants };
            }
        }

        if (!variants.length && !thaiFromDict.length) {
            const reason = thInfo.serverResponded
                ? 'Server ตอบแล้ว แต่ไม่มีผลแปล/Google ไม่ส่งข้อมูล'
                : 'ติดต่อ Translation Server ไม่สำเร็จ/หมดเวลา';
            cLog.warn(`🔤 [Translate Unavailable] ${reason} สำหรับชื่อ "${thaiSide.first}" -> SKIP เฉพาะ Fuzzy ข้ามภาษา แล้วไปตรวจ Bank Map ต่อ`);
            await reportUnmatchedName(thaiSide.first, enSide.first, 'แปลไม่ได้');
            return {
                isMatch: false,
                skipped: true,
                unavailable: true,
                percent: 0,
                translatedName: null,
                reason,
                reasonCode: 'translation_unavailable',
                candidates: []
            };
        }

        let finalPercent, thr, translatedName;
        if (thaiPercent > percent) {
            finalPercent = Math.round(thaiPercent);
            thr = shortNameThreshold(NAME_FUZZY_MATCH_THRESHOLD, Math.min(normalizeThaiNameForCompare(thaiBest).length, normalizeThaiNameForCompare(thaiSide.first).length) + 1);
            translatedName = thaiBest;
        } else {
            finalPercent = Math.round(percent);
            thr = shortNameThreshold(NAME_FUZZY_MATCH_THRESHOLD, enLen);
            translatedName = bestCandidate;
        }
        const isMatch = finalPercent >= thr;

        // --- 📌 Log แสดงการแปลชื่อและผลการเทียบ Fuzzy ข้ามภาษา ---
        cLog.info(`🔤 [Translate & Fuzzy] ${directionLabel} | ชื่อจริงไทย: "${thaiSide.first}" -> แปลได้: "${variants.join(' / ') || '-'}" [${thInfo.engine}] <==> ชื่อจริงอังกฤษ: "${enSide.first}" -> ความเหมือน ${finalPercent}% (เกณฑ์ ${thr}%) [${isMatch ? 'ผ่าน' : 'ไม่ผ่าน'}]`);
        if (!isMatch) {
            // แปลจาก dictionary (ยืนยันแล้ว) แต่ไม่ตรง = เป็นคนละคน ไม่ใช่ "แปลไม่สำเร็จ" -> ไม่รายงาน
            if (thInfo.engine !== 'dictionary') await reportUnmatchedName(thaiSide.first, enSide.first, `ไม่ผ่าน ${finalPercent}%`);
        } else if (finalPercent < NAME_REVIEW_PERCENT) {
            // ผ่านแต่ยังต่ำกว่า 70% -> เก็บให้ผู้ใช้ตรวจ/เพิ่มสะกดเข้า name_overrides.txt (สะกดตรง dictionary 100% ไม่เข้าเงื่อนไขนี้ ; ซ้ำ/มีใน overrides แล้ว server จะข้ามให้)
            await reportUnmatchedName(thaiSide.first, enSide.first, `ผ่านแต่ ${finalPercent}% ต่ำกว่า ${NAME_REVIEW_PERCENT}%`);
        }
        return { isMatch, percent: finalPercent, translatedName, thresholdUsed: thr, candidates: [...variants, ...thaiFromDict] };
    }

    // ชื่อไทย 2 ฝั่งเหมือนกันแต่ไม่เท่ากัน: ถ้าทั้งคู่อยู่ใน dictionary และสะกดอังกฤษคนละแบบ -> คนละชื่อ
    async function areKnownDifferentThaiNames(nameA, nameB) {
        const ia = await translateThaiFirstNameInfo(nameA);
        const ib = await translateThaiFirstNameInfo(nameB);
        if (ia.engine !== 'dictionary' || ib.engine !== 'dictionary') return false;
        const kb = ib.variants.map(v => v.replace(/[^A-Z]/g, ''));
        return !ia.variants.map(v => v.replace(/[^A-Z]/g, '')).some(x => kb.includes(x));
    }

    // ชื่ออังกฤษ 2 ฝั่งเหมือนกันแต่ไม่เท่ากัน (เช่น SOMCHAI vs SOMMAI): ถ้า dictionary รู้ว่าเป็น "ชื่อไทยคนละชื่อ" -> ไม่ใช่คนเดียวกัน
    async function areKnownDifferentEnglishNames(nameA, nameB) {
        const thA = await translateEnglishFirstNameToThaiDictionary(nameA);
        const thB = await translateEnglishFirstNameToThaiDictionary(nameB);
        if (!thA.length || !thB.length) return false;
        const nb = thB.map(normalizeThaiNameForCompare);
        return !thA.map(normalizeThaiNameForCompare).some(x => nb.includes(x));
    }

    // ส่งรายการที่เทียบชื่อไม่ผ่านไปบันทึกใน translate_misses.log (ภาษาไทย) ที่ server -- ล้มเหลวเงียบ ๆ ไม่กระทบการตัดสินใจ
    const _reportedMisses = new Set();
    async function reportNameMiss(senderNameValues, result) {
        try {
            if (!senderNameValues) return;
            const a = getFirstNameInfo(senderNameValues.orderText);
            const b = getFirstNameInfo(senderNameValues.slipText);
            const key = `${senderNameValues.orderText}|${senderNameValues.slipText}`;
            if (_reportedMisses.has(key)) return;
            _reportedMisses.add(key);
            const direction = (!a.first || !b.first) ? 'NONE'
                : (a.lang === b.lang ? (a.lang === 'TH' ? 'TH_TO_TH' : 'EN_TO_EN') : (a.lang === 'TH' ? 'TH_TO_EN' : 'EN_TO_TH'));
            const reason = (!a.first || !b.first) ? 'no_first_name'
                : (result.reasonCode || (result.reason === 'known_different' ? 'known_different' : 'below_threshold'));
            const params = {
                order: senderNameValues.orderText || '', slip: senderNameValues.slipText || '',
                orderFirst: a.first, slipFirst: b.first, direction,
                percent: result.percent || 0, threshold: result.thresholdUsed || NAME_FUZZY_MATCH_THRESHOLD,
                translated: result.translatedName || '', candidates: (result.candidates || []).join('|'), reason
            };
            const url = TRANSLATE_API_URL.replace(/\/translate$/, '/log-miss') + '?' +
                Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
            await new Promise((resolve) => {
                if (typeof GM_xmlhttpRequest === 'function') {
                    GM_xmlhttpRequest({ method: 'GET', url, timeout: 10000, onload: () => resolve(), onerror: () => resolve(), ontimeout: () => resolve() });
                } else {
                    fetch(url).then(() => resolve()).catch(() => resolve());
                }
            });
        } catch (e) { /* ไม่กระทบการตัดสินใจหลัก */ }
    }

    // ตัวกลางที่ verifySenderWhenNameMismatch เรียก  ** ต้อง await **
    async function checkSenderNameFuzzyMatchGeneral(senderNameValues) {
        const result = await checkSenderNameFuzzyMatchGeneralCore(senderNameValues);
        if (result && !result.isMatch) await reportNameMiss(senderNameValues, result);
        return result;
    }

    // ภาษาเดียวกันเทียบเลย / ต่างภาษาไปแปลผ่าน server
    async function checkSenderNameFuzzyMatchGeneralCore(senderNameValues) {
        const quick = checkSenderNameFuzzyMatchThai(senderNameValues);
        if (quick.needsTranslation) return await checkSenderNameFuzzyMatch(senderNameValues);

        if (quick.isMatch && quick.percent < 100) {
            const a = getFirstNameInfo(senderNameValues.orderText);
            const b = getFirstNameInfo(senderNameValues.slipText);
            if (a.lang === 'TH' && b.lang === 'TH' && await areKnownDifferentThaiNames(a.first, b.first)) {
                cLog.info(`🔤 [Fuzzy Match TH] "${a.first}" กับ "${b.first}" เป็นคนละชื่อใน dictionary -> ไม่ผ่าน`);
                return { isMatch: false, percent: 0, reason: 'known_different' };
            }
            if (a.lang === 'EN' && b.lang === 'EN' && await areKnownDifferentEnglishNames(a.first, b.first)) {
                cLog.info(`🔤 [Fuzzy Match EN] "${a.first}" กับ "${b.first}" เป็นคนละชื่อใน dictionary -> ไม่ผ่าน`);
                return { isMatch: false, percent: 0, reason: 'known_different' };
            }
        }
        return quick;
    }

    function setNativeValue(element, value) {
        const proto = element.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (nativeSetter) {
            nativeSetter.call(element, value);
        } else {
            element.value = value;
        }
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
    }

    async function findRejectReasonField(timeout = 5000) {
        const trySelectors = [
            'textarea[placeholder*="สลิปไม่ตรง"]',
            'textarea[placeholder*="สลิป"]',
            'div[role="dialog"] textarea',
            'textarea',
            'div[role="dialog"] [contenteditable="true"]',
            '[contenteditable="true"]'
        ];

        const start = Date.now();
        while (Date.now() - start < timeout) {
            for (const sel of trySelectors) {
                const el = document.querySelector(sel);
                if (el && el.offsetParent !== null) return el;
            }
            await sleep(200);
        }
        return null;
    }

    // --- ฟังก์ชันสำหรับการ "ปฏิเสธ" พร้อมใส่หมายเหตุ ---
    async function rejectOrder(reason) {
        const rejectBtn = await waitForButtonByText('ปฏิเสธ', 5000);
        if (!rejectBtn) {
            recordTechnicalFailure('หาปุ่ม "ปฏิเสธ" ไม่เจอ');
            return false;
        }

        rejectBtn.click();

        const textarea = await findRejectReasonField(5000);
        if (!textarea) {
            recordTechnicalFailure('หาช่องกรอกหมายเหตุ ไม่เจอ');
            return false;
        }

        textarea.focus();
        setNativeValue(textarea, reason);
        await sleep(500);

        const confirmRejectBtn = await waitForButtonByText('ยืนยันการปฏิเสธ', 5000);
        if (!confirmRejectBtn) {
            recordTechnicalFailure('หาปุ่ม "ยืนยันการปฏิเสธ" ไม่เจอ');
            return false;
        }

        if (confirmRejectBtn.disabled) {
            const checkboxFound = await checkApprovalWarningCheckboxIfPresent();
            let confirmRejectBtnFresh = confirmRejectBtn;
            if (checkboxFound) {
                const pollStart = Date.now();
                while (Date.now() - pollStart < 3000) {
                    confirmRejectBtnFresh = await waitForButtonByText('ยืนยันการปฏิเสธ', 800) || confirmRejectBtnFresh;
                    if (!confirmRejectBtnFresh.disabled) break;
                    await sleep(200);
                }
            } else {
                await sleep(300);
            }
            if (confirmRejectBtnFresh.disabled) {
                recordTechnicalFailure('ปุ่ม "ยืนยันการปฏิเสธ" ยัง disabled อยู่');
                return false;
            }
            confirmRejectBtnFresh.click();
        } else {
            confirmRejectBtn.click();
        }
        cLog.error(`ปฏิเสธรายการสำเร็จ พร้อมเหตุผล: ${reason}`);
        recordTechnicalSuccess();
        await sleep(350);
        return true;
    }

    // --- ฟังก์ชันสำหรับข้ามหรือปิดหน้าต่างป็อปอัป ---
    async function closePopup() {
        const visibleDialogs = () => Array.from(document.querySelectorAll('div[role="dialog"]')).filter(isVisible);
        if (!visibleDialogs().length) return;
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        const started = Date.now();
        while (Date.now() - started < 450) {
            if (!visibleDialogs().length) return;
            await sleep(50);
        }
        await sleep(100);
    }

})();