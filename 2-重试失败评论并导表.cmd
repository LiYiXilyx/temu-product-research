@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在重试评论抓取失败的商品...
call npm.cmd run reviews:retry
if errorlevel 1 goto failed
echo 正在更新运营Excel...
call npm.cmd run export
if errorlevel 1 goto failed
echo.
echo 已完成。请打开 outputs\week1-mvp\Temu第一周选品结果.xlsx
pause
exit /b 0

:failed
echo.
echo 执行失败，请保留本窗口中的错误信息并联系开发人员。
pause
exit /b 1
