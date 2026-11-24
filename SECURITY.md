# 安全策略

## 报告漏洞

请**不要**通过公开 Issue 报告安全漏洞。

- **首选**：在本仓库点击 **Security → Report a vulnerability** 提交私密报告
  （需维护者在 Settings → Security 中开启 Private vulnerability reporting）。
- 若该入口未开启，请通过 GitHub 私信联系维护者
  （[@Hyperion-WB](https://github.com/Hyperion-WB)），切勿公开披露利用细节。

请尽量包含：影响版本、复现步骤、影响范围、修复建议。我们会在 72 小时内确认收到，并在修复后公开致谢（如果你愿意）。

## 部署安全清单

开源代码公开后，攻击者也能看到实现细节。上线前请确认：

- [ ] `JWT_SECRET_KEY` 为随机值（`openssl rand -hex 32`），且未提交到仓库
- [ ] 数据库、Redis 不暴露公网端口
- [ ] 管理员首次登录已强制改密
- [ ] `ENABLE_API_DOCS` 保持关闭（生产）
- [ ] `CORS_ORIGINS` 只填真实前端域名（同源部署可留空）
- [ ] 上传目录不挂载为可执行，nginx 已开启 `X-Content-Type-Options: nosniff`
- [ ] 全站 HTTPS，反向代理限流开启
- [ ] 开启 GitHub Secret Scanning / Dependabot
- [ ] 定期备份数据库与上传目录，并验证可恢复

## 支持范围

仅对 `main` 分支的最新版本提供安全修复。
