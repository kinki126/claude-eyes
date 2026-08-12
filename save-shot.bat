@echo off
rem save-shot.bat - save clipboard screenshot to <this-folder>\shots\
rem Usage: Win+Shift+S (into clipboard) -> run this -> tell Claude "analyze latest screenshot"
setlocal
set SHOT_DIR=%~dp0shots
if not exist "%SHOT_DIR%" mkdir "%SHOT_DIR%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Add-Type -AssemblyName System.Windows.Forms; $img=[System.Windows.Forms.Clipboard]::GetImage(); if($null -eq $img){Write-Host 'No image in clipboard - press Win+Shift+S first'; exit 1}; $name='clip-'+(Get-Date -Format 'yyyyMMdd-HHmmss')+'.png'; $path=Join-Path '%SHOT_DIR%' $name; $img.Save($path); Write-Host ('Saved: '+$path)"
