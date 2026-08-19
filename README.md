# Temu 第一周选品采集 MVP

这是一个全新实现，不依赖工作区中的旧原型。第一周目标是稳定跑通：

1. 德国站 / 英语 / EUR / Top Sales 分类页采集。
2. 商品详情、评论质量字段与近 7/30/90 天评价采集。
3. SQLite 保存商品、原始评价、主题证据、断点、运行记录和异常分类。
4. 计算日均评价、生命周期信号、电子/USB排除、是否入选及多标签差评主题占比。
5. 生成包含“选品结果、评论明细、差评主题分析、评论抓取进度、字段说明”的 Excel 报表。

## 目录

- `src/`：采集、解析、数据库和分析代码。
- `tools/build-report.mjs`：从 SQLite 生成 Excel。
- `test/`：解析、筛选和数据库单元测试。
- `data/`：运行后生成的 SQLite 数据库，默认不提交。
- `outputs/week1-mvp/`：Excel和内部QA预览，默认不提交。
- `browser-profile-fresh/`：运营专用 Chrome 的长期登录会话，默认不提交，也不要共享。

## 初始化

需要 Node.js 22+，并安装 `playwright` 与 `@oai/artifact-tool`：

```powershell
npm install
npm run init
```

编辑 `config.json`：

- `jobs[0].url` 只供旧的开发刷新命令兜底；运营台“采集当前页面”不依赖该链接。
- 填写一级类目、子类目。
- 第一周先保留 `targetCount: 100`。

首次安装Playwright浏览器：

```powershell
npx playwright install chromium
```

程序只使用Google Chrome，不会自动切换到Microsoft Edge。它会检查当前用户目录和两个常见系统安装目录；也可以在 `browser.executablePath` 中手动指定 `chrome.exe` 的完整路径。

## 运行

运营人员推荐直接双击 `启动Temu运营台.vbs`。它会隐藏后台窗口并打开本地运营台，页面提供采集 Chrome、当前页采集、评论批次、失败重试、Excel导出、实时日志和人工确认按钮。

```powershell
npm run dashboard
npm run capture
npm run crawl
npm run export
```

日常流程由运营台完成：先打开采集 Chrome，人工进入德国站摩托配件并选择 `Top Sales`，再点击“采集当前页面”。`npm run capture` 是同一功能的开发命令；它只连接已经打开的采集 Chrome，不导航、不搜索、不刷新。成功采集后，旧链接会退出当前运营队列但保留历史数据；新商品自动进入评论待抓队列。

已有商品后，运营按 Top Sales 页面名次手动打开商品详情，脚本只采集当前页并自动记录进度：

```powershell
npm run current-review
npm run export
```

推荐直接在运营台点击“采集当前商品”：当前商品完成后返回 Top Sales 列表，手动打开下一个商品，再重复点击。这样保留运营人员已经验证正常的页面会话，避免脚本直接打开数据库旧链接后出现空白页。重复采集同一商品不会产生重复评论。

`reviews` 自动批量方式仍作为开发兜底，不作为运营主入口。它直接读取SQLite中的真实Temu商品，自动排除 `demo` 数据；失败商品不会阻塞整批：

```powershell
npm run reviews:retry
```

如需主动重新抓已经存在评论的商品，可运行：

```powershell
node src/cli.mjs reviews --config config.json --batch-size 10 --include-reviewed
```

`npm run export:qa` 会额外把五张工作表渲染为内部预览图并扫描公式错误；正常的 `npm run export` 也会检查Excel数据与公式。

交给运营后只需双击 `启动Temu运营台.vbs`。运营台还提供带二次确认的“清除 Excel 内容”按钮：它只生成保留表头的空白报表，不删除 SQLite 数据；点击“重新导出”即可恢复完整报表。下面的 CMD 文件保留为开发兜底，不作为日常操作入口：

- `0-刷新TopSales商品池并导表.cmd`
- `1-抓取下一批评论并导表.cmd`
- `2-重试失败评论并导表.cmd`
- `3-仅重新导出Excel.cmd`

采集 Chrome 是由运营台启动的可见普通 Chrome，使用独立且持久的资料目录。请人工完成 VPN、登录及验证码；程序不会绕过验证。不要连接或复制日常主浏览器资料目录。

## 不访问Temu的本地验收

```powershell
npm test
npm run demo
```

`demo` 会写入3个模拟商品及可追溯评价，并生成 `outputs/week1-mvp/Temu第一周选品结果.xlsx`，用于验证数据库、筛选公式和Excel布局。

## 当前边界

- 上架时间仅用“当前已抓评价中的最早日期”估算，并明确标记，不冒充平台官方上架时间。
- Temu页面结构改变时，需要更新 `config.json` 的选择器。
- 采集频率默认较低；不建议提高并发或去掉停顿。
- 同类Top50、竞争度、1688寻源和自动上架字段已预留，但不属于第一周实现范围。

## 阶段门与验收

1. 前10个真实商品：尽量完整抓取评论，至少8个成功；去重、异常分类、断点、近30天活跃度、生命周期、差评证据和运营Excel全部通过。
2. 100个商品：只在前10通过后执行，抓近30天及部分历史评论，用于稳定性验证。
3. 1000个商品池：只抓商品基础指标，不批量深抓评论。
4. 分类与市场分析后筛出2–5个子类，每类10–30个重点商品，再深抓评论和生命周期信号。
5. 人工确定3–10个候选产品后，才进入1688寻源。

前10验收字段包括日期、星级、正文、SKU、图片、地区和来源链接。默认1–3星为差评，阈值可配置；一条评论允许命中多个主题。每个主题同时保存占全部评论比例、占全部差评比例、评论数、商品数、近30天新增数和原始证据。
