# 贡献指南

感谢你愿意为这个项目贡献代码。提交 PR 前，请先读完本文。

## 可以贡献什么

- Bug 修复（请附复现步骤或失败用例）
- 性能优化（请给出前后对比数据）
- 文档与示例补充
- 新功能：**请先开 Issue 讨论**，避免做完才发现方向不一致

## 开发环境

### 一键启动（Docker）

```bash
cp .env.example .env
# 生成 JWT 密钥（必填）
sed -i "s|^JWT_SECRET_KEY=.*|JWT_SECRET_KEY=$(openssl rand -hex 32)|" .env
bash scripts/build_frontend.sh
docker compose up -d --build
```

### 本地开发

后端：

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

前端：

```bash
cd frontend
npm ci
npm run dev
```

> 本地开发可设置 `ENVIRONMENT=development`，未配置 `JWT_SECRET_KEY` 时后端会生成进程级临时密钥（重启后登录态失效）。

## 分支与提交

- 从 `main` 切出：`feat/xxx`、`fix/xxx`、`docs/xxx`
- 提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/)：
  - `feat: 群聊支持语音消息`
  - `fix: 修复图片清理任务误删聊天图片`
- 一个 PR 只做一件事，过大的改动请拆分

## PR 要求

1. `npx tsc -b`、`npx oxlint src`、`npm run build` 通过
2. 后端改动至少 `python -m compileall backend/app` 通过
3. 涉及 UI 的改动附截图或录屏
4. 说明「改了什么、为什么改、如何验证」
5. 不要提交 `.env`、上传文件、数据库文件、日志或任何真实密钥

## 代码风格

- 前端：TypeScript + React 函数组件 + Tailwind；遵循现有目录结构与命名
- 后端：FastAPI + SQLAlchemy 2.0 async；数据库变更必须写进 `backend/app/core/migrations.py`
- 注释用中文，解释「为什么」而不是复述代码

## 安全

- 不要在 Issue/PR 里贴真实漏洞利用细节，请按 [SECURITY.md](SECURITY.md) 私下报告
- 依赖升级请在 PR 中附 `pip-audit` / `npm audit` 结果

## 许可

提交 PR 即表示你同意以本仓库的 MIT 许可证发布你的贡献。
