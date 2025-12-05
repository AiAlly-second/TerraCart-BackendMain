@echo off
echo ========================================
echo TerraCart Backend - Firewall Rule Setup
echo ========================================
echo.
echo This script will add a Windows Firewall rule
echo to allow incoming connections on port 5001.
echo.
echo NOTE: This requires Administrator privileges.
echo.
pause

netsh advfirewall firewall add rule name="TerraCart Backend Port 5001" dir=in action=allow protocol=TCP localport=5001

if %ERRORLEVEL% EQU 0 (
    echo.
    echo ========================================
    echo SUCCESS! Firewall rule added.
    echo ========================================
    echo.
    echo Port 5001 is now open for incoming connections.
    echo Your mobile app should now be able to connect.
    echo.
) else (
    echo.
    echo ========================================
    echo ERROR: Failed to add firewall rule.
    echo ========================================
    echo.
    echo Please run this script as Administrator:
    echo 1. Right-click this file
    echo 2. Select "Run as administrator"
    echo.
)

pause

