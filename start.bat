@echo off
cd /d "%~dp0"
if not exist node_modules ( echo Memasang dependensi... & call npm install )
if not exist .env ( copy .env.example .env >nul & echo File .env dibuat. Isi API key bila ingin mode LIVE. )
start "" http://localhost:3000
node server.js
pause
