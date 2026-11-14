@echo off
chcp 65001 > nul
title Thai Name Transliteration API Server

cd /d "%~dp0"

echo ============================================================
echo   Checking environment and dependencies...
echo ============================================================

:: 1. ตรวจสอบว่ามี Node.js ในเครื่องหรือยัง
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] เครื่องนี้ยังไม่ได้ติดตั้ง Node.js!
    echo กรุณาดาวน์โหลดและติดตั้ง Node.js จาก https://nodejs.org ก่อนใช้งาน
    echo.
    pause
    exit /b
)

:: 2. ตรวจสอบว่ามีไฟล์ระบบ server.js อยู่หรือไม่
if not exist server.js (
    echo [ERROR] ไม่พบไฟล์ server.js ในโฟลเดอร์นี้!
    echo กรุณานำไฟล์ server.js มาไว้ที่เดียวกับไฟล์ .bat นี้
    echo.
    pause
    exit /b
)

:: 3. สร้าง package.json อัตโนมัติหากยังไม่มี
if not exist package.json (
    echo [INFO] ไม่พบ package.json กำลังสร้างไฟล์ตั้งค่าให้อัตโนมัติ...
    (
      echo {
      echo   "name": "thai-name-api",
      echo   "version": "4.3.0",
      echo   "main": "server.js",
      echo   "scripts": {
      echo     "start": "node server.js"
      echo   },
      echo   "dependencies": {
      echo     "cors": "^2.8.5",
      echo     "express": "^4.18.2"
      echo   }
      echo }
    ) > package.json
)

:: 4. ตรวจสอบโฟลเดอร์ node_modules (ถ้าย้ายเครื่องใหม่แล้วยังไม่มี จะทำการโหลดให้ทันที)
if not exist node_modules\express (
    echo [INFO] ตรวจสอบไม่พบ node_modules (เครื่องใหม่^)...
    echo [INFO] กำลังดาวน์โหลดและติดตั้ง Library ^(Express, Cors^) ให้อัตโนมัติ...
    echo ------------------------------------------------------------
    call npm install
    echo ------------------------------------------------------------
    if not exist node_modules\express (
        echo [ERROR] ติดตั้ง Library ไม่สำเร็จ - ตรวจสอบอินเทอร์เน็ตแล้วเปิดไฟล์นี้ใหม่
        echo.
        pause
        exit /b
    )
    echo [SUCCESS] ติดตั้ง Library เรียบร้อยแล้ว!
    echo.
)

:: 5. เริ่มรันเซิร์ฟเวอร์ทันที
echo ============================================================
echo   Starting API Server (node server.js)...
echo ============================================================
echo.
node server.js

pause