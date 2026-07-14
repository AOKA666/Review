# PROJECT

## TODO
- [x] 完成首次本地安装、构建和开发服务验证；本地 Supabase 数据接口可用
- [ ] 确认 Vercel 正式环境变量配置与本地 `.env.local` 保持一致
- [ ] 按 `调整建议.md` 的方向，把首页重构成"轻记录 + 可选深度复盘"双层结构（默认只展开顶部 textarea）
- [ ] 删除/检查 `app/api/weekly-summary/route.ts` 与 `app/page.tsx` 中周总结相关代码是否完整、可运行
- [ ] 清理仓库根目录的调试脚本 `inspect.py`、`replace2.py`，判断是否还需要保留
- [ ] `tsconfig.tsbuildinfo`、`package-lock.json` 等是否应纳入 `.gitignore`（目前 `.gitignore` 未忽略 tsbuildinfo）
- [x] 周复盘严格只渲染红榜、黑榜、关键规律、下周行动四张卡片，忽略模型返回的标题和前言

## DECISIONS
- 周复盘前端解析器只将四类业务小标题识别为卡片；模型返回的文档标题、日期范围和标题前言不单独生成卡片

## LOG
- 2026-07-14 仓库从 https://github.com/AOKA666/Review.git 克隆到本地 `Review/` 工作区，确认 main 分支最新提交为 `周总结`（76d1724，2026-07-13）
- 2026-07-14 修复 `# 周复盘（日期范围）` 被解析成第五张“周复盘总结”卡片的问题；新增解析器回归测试，测试和生产构建通过