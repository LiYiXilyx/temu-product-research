@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在从Temu德国站刷新当前Top Sales摩托配件商品池...
echo 本步骤只抓商品列表，不抓评论，也不会上架商品。
call npm.cmd run refresh
if errorlevel 1 goto failed
echo 正在更新运营Excel...
call npm.cmd run export
if errorlevel 1 goto failed
echo.
echo 商品池已刷新。下一步请双击 1-抓取下一批评论并导表.cmd
echo Excel位置：outputs\week1-mvp\Temu第一周选品结果.xlsx
pause
exit /b 0

:failed
echo.
echo 刷新失败，旧商品池不会被清空。请保留本窗口中的错误信息并联系开发人员。
pause
exit /b 1
