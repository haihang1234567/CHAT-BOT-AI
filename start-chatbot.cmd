@echo off
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Chua tim thay Node.js. Hay cai Node.js 18 tro len truoc.
  pause
  exit /b 1
)

if not exist ".env" (
  copy /Y ".env.example" ".env" >nul
  echo Da tao file .env. Hay mo file .env de dien token va model AI de bat che do AI hai tang.
)

echo.
echo Chatbot dang chay tai: http://localhost:3000
echo Trang quan tri:       http://localhost:3000/admin.html
echo Nhan Ctrl+C de dung.
echo.
node server.js
pause
