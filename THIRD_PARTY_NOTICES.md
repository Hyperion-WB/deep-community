# 第三方资源与许可

本项目自身以 [MIT](LICENSE) 发布。以下资源随项目分发，版权归原作者所有，请遵守各自许可。

## 代码 / 游戏

| 资源 | 来源 | 许可 | 位置 |
|---|---|---|---|
| flea-game（2048 / 恐龙 / 扫雷等小游戏） | https://github.com/huazie/flea-game | MIT | `frontend/public/flea-games/`（含 LICENSE） |
| ChineseChessOnline（象棋规则与棋盘渲染移植） | https://gitee.com/stringify/ChineseChessOnline | MIT | `frontend/src/components/minigames/xiangqiAI*`、`ChineseChessBoard.tsx` |
| 成语库 | https://github.com/crazywhalecc/idiom-database | 见上游仓库 | `backend/app/data/idioms.json` |
| 诗词数据（全唐诗 / 宋词 / 诗经 / 楚辞 / 元曲等） | https://github.com/chinese-poetry/chinese-poetry | 见上游仓库 | 由 `scripts/import_poetry.py` 构建为 `backend/app/data/poetry.db` |

## 图标 / 字体

| 资源 | 来源 | 许可 |
|---|---|---|
| lucide-react 图标 | https://lucide.dev | ISC |
| HarmonyOS Sans 字体 | 华为 HarmonyOS 字体 | 免费商用（遵循华为字体许可，详见上游） |

## 依赖

Python 依赖见 `backend/requirements.txt`，前端依赖见 `frontend/package.json`，各自遵循其上游许可（MIT / Apache-2.0 / BSD 等）。

如你是上述资源的作者并认为署名方式需要调整，请提交 Issue，我们会尽快处理。
