@echo off
setlocal EnableExtensions
chcp 65001 >nul
title Thai Name Transliteration API Server
cd /d "%~dp0"

:check_environment
echo ============================================================
echo   ตรวจสอบ Node.js และ Library ที่จำเป็น
echo ============================================================
where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] ไม่พบ Node.js กรุณาติดตั้งจาก https://nodejs.org แล้วเปิดไฟล์นี้ใหม่
    pause
    exit /b 1
)
where npm >nul 2>nul
if errorlevel 1 (
    echo [ERROR] ไม่พบ npm ซึ่งติดตั้งมาพร้อม Node.js กรุณาติดตั้ง Node.js ใหม่
    pause
    exit /b 1
)
if not exist server.js (
    echo [ERROR] ไม่พบ server.js ในโฟลเดอร์นี้
    pause
    exit /b 1
)

if not exist package.json (
    echo [ERROR] ไม่พบ package.json จึงไม่สามารถตรวจสอบเวอร์ชันและติดตั้ง Library ได้
    pause
    exit /b 1
)

for /f "delims=" %%V in ('node -p "require('./package.json').version || 'ไม่ระบุ'" 2^>nul') do set "APP_VERSION=%%V"
echo [INFO] เวอร์ชัน package.json: %APP_VERSION%

:: ตรวจ dependency ด้วยการ require จริง ไม่เช็คแค่ชื่อโฟลเดอร์
node -e "require('express'); require('cors')" >nul 2>nul
if errorlevel 1 (
    echo [INFO] Library ไม่ครบหรือโหลดใช้ไม่ได้ กำลังติดตั้งจาก package.json...
    call npm install
    if errorlevel 1 (
        echo [ERROR] npm install ไม่สำเร็จ กรุณาตรวจอินเทอร์เน็ตและ package.json
        pause
        exit /b 1
    )
)

node -e "require('express'); require('cors')" >nul 2>nul
if errorlevel 1 (
    echo [ERROR] ยังเรียกใช้ Express/CORS ไม่ได้หลังติดตั้ง กรุณาตรวจสอบข้อผิดพลาด npm
    pause
    exit /b 1
)
echo [SUCCESS] ตรวจพบ Node.js, Express และ CORS ครบแล้ว

:run_server
echo.
echo ============================================================
echo   เริ่ม Translation API (server.js) เวอร์ชัน %APP_VERSION%
echo   กด Ctrl+C เพื่อหยุด แล้วเลือกว่าจะรันใหม่หรือออก
echo ============================================================
node server.js
echo.
echo [INFO] Server หยุดทำงาน (รหัสออก %errorlevel%)

:after_server
echo.
echo [1] เริ่ม/รัน Server ใหม่
echo [2] ออกจากโปรแกรม
choice /C 12 /N /M "เลือก 1 หรือ 2: "
if errorlevel 2 goto exit_program
if errorlevel 1 goto run_server

:exit_program
echo [INFO] ออกจากโปรแกรมแล้ว
endlocal
exit /b 0
