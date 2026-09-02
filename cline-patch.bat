@echo off
rem ============================================================
rem  Applies / Re-applies the Ollama body-timeout patch to Cline.
rem
rem  Run this again after Cline updates itself (an update
rem  replaces the extension files and removes the patch).
rem  You don't run it on normal startup.
rem  The patch is written directly into Cline's files on disk and persists across reboots/reloads
rem
rem  After running: Ctrl+Shift+P > "Developer: Reload Window"
rem  or just restart vscode.
rem ============================================================
cd /d "%~dp0"
node patch-cline.cjs
echo.
pause