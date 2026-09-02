@echo off
rem Double-click to publish a release. Everything worth checking is checked in the script.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\release.ps1"
pause
