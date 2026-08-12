@echo off
rem start-bridge.bat - start local image analysis bridge (port 8765)
rem Portable: runs from this file's own folder.
cd /d "%~dp0"
node zhipu-bridge-api.js
