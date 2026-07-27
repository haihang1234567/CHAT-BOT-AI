$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "Chưa tìm thấy Node.js. Hãy cài Node.js 18 trở lên."
}

if (-not (Test-Path ".env")) {
    Copy-Item ".env.example" ".env"
    Write-Host "Đã tạo .env. Hãy điền token và model AI để bật chế độ AI hai tầng." -ForegroundColor Yellow
}

Write-Host "Chatbot: http://localhost:3000" -ForegroundColor Green
Write-Host "Admin:   http://localhost:3000/admin.html" -ForegroundColor Green
node server.js
