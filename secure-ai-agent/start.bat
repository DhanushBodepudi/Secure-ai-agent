@echo off
title Aperture - Secure AI Agent
echo ========================================================
echo   Starting Aperture - Secure AI Agent
echo ========================================================
cd /d "%~dp0backend"
echo Opening browser at http://localhost:4000 ...
start http://localhost:4000
echo Running server on port 4000...
node server.js
pause
