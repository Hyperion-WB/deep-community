# 社区开放 API · 普通用户端

> 本文档面向第三方客户端（移动 App、桌面客户端、机器人、数据展示页等）开发者。
> 仅描述**普通用户可以使用的能力**，不包含任何站点管理、审计、运维相关接口。

---

## 0. 范围与约定

### 0.1 适用对象

| 客户端 | 能力 |
|---|---|
| **网页端** | 注册账号、登录、以及本文档列出的全部普通用户操作 |
| **App / 第三方客户端** | **不提供注册**。使用已在网页端注册好的账号登录，登录后可执行普通用户操作（浏览、发帖、评论、聊天、上传图片等） |

> 账号的创建、邮箱验证、邀请码填写均在网页端完成。第三方客户端只需要实现「登录」与「登录后操作」。

### 0.2 不在本文档范围内

以下内容**不在**开放范围内，第三方客户端不应依赖、也不应尝试调用：

- 用户管理、封禁、角色任免、等级调整、状态变更
- 内容审核、举报处理、敏感词、审计日志
- 站点公告发布、邀请码发放、友链审核
- 置顶 / 加精 / 锁定 / 移动分区 / 采纳答案等**版务操作**
- 运维统计、服务器状态、存储信息

这些操作只对站点管理人员开放，且可能随版本调整。

### 0.3 权限模型

接口按是否需要登录分为三类：

| 标记 | 含义 |
|---|---|
| `公开` | 无需登录，可直接调用 |
| `登录` | 需要携带有效的访问令牌 |
| `物主` | 需要登录，且只能操作自己创建的内容（或自己所在的会话） |

所有接口都遵循「最小权限」：普通用户只能操作自己的资料、帖子、评论、会话与表情包。

---

## 1. 通用约定

### 1.1 请求地址

```
https://<站点域名>/api/...
```

`<站点域名>` 由接入方自行填写，本文所有路径均从 `/api` 开始，使用相对路径表示。

### 1.2 认证方式

登录成功后会返回 `access_token`（短期访问令牌），后续请求放在请求头里：

```
Authorization: Bearer <access_token>
```

- 访问令牌有时效，过期后调用 `POST /auth/refresh` 换取新的访问令牌
- 刷新令牌通过 **HttpOnly Cookie** 下发，客户端无需也无法用 JS 读取；只要保持同一会话的 Cookie，即可静默续签
- 原生 App 需要启用 Cookie 持久化（或使用支持 Cookie Jar 的 HTTP 客户端）
- 退出登录调用 `POST /auth/logout`，之后该会话的刷新凭证失效

### 1.3 请求格式

- 除文件上传外，请求与响应均为 `application/json`
- 文件上传使用 `multipart/form-data`，字段名统一为 `file`
- 路径中的 `{id}` 为 UUID 字符串

### 1.4 响应与错误

成功时返回 JSON（部分接口直接返回数组）。失败时统一格式：

```json
{ "detail": "错误说明" }
```

常见状态码：

| 状态码 | 含义 |
|---|---|
| `200` | 成功 |
| `201` | 创建成功（部分接口仍返回 200） |
| `400` | 参数不合法、内容不合规、业务规则未满足 |
| `401` | 未登录或令牌失效，需要重新续签 / 登录 |
| `403` | 已登录但无权限（例如操作别人的内容） |
| `404` | 资源不存在 |
| `409` | 资源冲突（例如重复） |
| `429` | 触发频率限制，响应 `detail` 会说明原因 |

### 1.5 分页

列表类接口使用 `page`（从 1 开始）与 `size`：

```
GET /api/posts?page=1&size=20
```

部分列表会在响应头中返回总数（如 `X-Total-Count`），客户端也可以按「返回条数 < size」判断是否已到末页。

### 1.6 时间与 ID

- ID 为 UUID 字符串
- 时间为 ISO 8601（UTC），例如 `2026-11-07T08:30:00Z`
- 客户端展示时请自行换算为本地时区

### 1.7 频率与配额

站点对部分操作设有频率与数量限制，触发时返回 `429`，`detail` 会给出可读的原因。客户端应当：

- 对 `429` 做退避重试或直接提示用户，不要立即狂刷
- 图片类接口有每日/每周配额，建议在上传前给用户明确提示

> 具体数值可能随运营策略调整，请以接口实际返回为准，不要硬编码。

### 1.8 数据与隐私

- 匿名发表的内容不会暴露真实作者
- 用户可自行关闭在线状态、设置免打扰；客户端应尊重这些偏好
- 第三方客户端不得缓存、转售或公开用户个人信息

---

## 2. 认证

### 2.1 登录

```
POST /api/auth/login
```

权限：`公开`

请求：

```json
{
  "username_or_email": "your_account",
  "password": "your_password",
  "captcha_token": null
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `username_or_email` | string | 是 | 用户名或邮箱 |
| `password` | string | 是 | 密码 |
| `captcha_token` | string \| null | 否 | 连续输错密码后按服务端要求附带 |

响应：

```json
{
  "access_token": "<jwt>",
  "refresh_token": null,
  "token_type": "bearer"
}
```

> `refresh_token` 通常为 `null`，刷新凭证通过 HttpOnly Cookie 下发。保留该字段只为兼容旧客户端。

### 2.2 注册（仅网页端）

```
POST /api/auth/register
```

> **App / 第三方客户端不实现此接口。** 账号在网页端注册，App 只做登录。
> 文档列出它仅为说明账号来源，字段可能包含邀请码、邮箱验证码、人机验证等网页端流程，第三方不应自行实现注册页。

### 2.3 续签

```
POST /api/auth/refresh
```

权限：`公开`（依赖 Cookie）

请求体可为空；兼容旧客户端时也可传 `{ "refresh_token": "..." }`。

响应同登录。建议在收到 `401` 时静默调用一次，成功则重试原请求。

### 2.4 退出登录

```
POST /api/auth/logout
```

权限：`登录`

响应：`{ "message": "已退出登录" }`

### 2.5 当前用户

```
GET /api/auth/me
```

权限：`登录`

返回当前账号资料，典型字段：

```json
{
  "id": "<uuid>",
  "username": "your_account",
  "nickname": "展示用的昵称",
  "email": "you@example.com",
  "role": "user",
  "level": 6,
  "avatar_url": "/uploads/...",
  "is_online": true
}
```

> 客户端应以响应实际字段为准；未设置的字段可能为 `null`。

### 2.6 密码找回（网页端流程）

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/auth/email/code` | 发送邮箱验证码 |
| `POST` | `/api/auth/password/forgot` | 申请找回 |
| `POST` | `/api/auth/password/reset` | 用验证码重置 |

第三方客户端建议直接引导用户到网页端完成，不必内置该流程。

---

## 3. 用户与资料

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| `GET` | `/api/users/profile/{username}` | 公开 | 公开主页资料 |
| `PUT` | `/api/users/me` | 登录 | 修改自己的昵称、简介等 |
| `POST` | `/api/users/me/avatar` | 登录 | 上传/更换头像（`multipart/form-data`） |
| `PUT` | `/api/users/me/password` | 登录 | 修改密码 |
| `PUT` | `/api/users/me/privacy` | 登录 | 隐私偏好（在线状态等） |
| `PUT` | `/api/users/me/dnd` | 登录 | 免打扰开关 |
| `GET` | `/api/users/search?q=` | 登录 | 搜索用户 |
| `GET` | `/api/users/{username}/posts` | 公开 | 某用户发表的帖子 |
| `POST` | `/api/users/{username}/follow` | 登录 | 关注 |
| `DELETE` | `/api/users/{username}/follow` | 登录 | 取消关注 |
| `GET` | `/api/users/{username}/following` | 公开 | 关注列表 |
| `GET` | `/api/users/{username}/followers` | 公开 | 粉丝列表 |
| `POST` | `/api/users/{username}/block` | 登录 | 屏蔽用户 |
| `DELETE` | `/api/users/{username}/block` | 登录 | 取消屏蔽 |
| `GET` | `/api/users/me/blocks` | 登录 | 我的屏蔽列表 |
| `POST` | `/api/users/checkin` | 登录 | 每日签到 |
| `GET` | `/api/users/me/posts` | 登录 | 我发表的帖子 |
| `GET` | `/api/users/me/collections` | 登录 | 我的收藏 |
| `GET` | `/api/users/me/invite-codes` | 登录 | 我的邀请码 |
| `POST` | `/api/users/me/invite-codes` | 登录 | 生成邀请码（若有资格） |
| `POST` | `/api/users/me/deactivate` | 登录 | 自助注销账号 |

---

## 4. 通知

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| `GET` | `/api/users/me/notifications?page=1&size=20` | 登录 | 通知列表 |
| `GET` | `/api/users/me/notifications/unread-count` | 登录 | 未读数量（红点） |
| `PUT` | `/api/users/me/notifications/read` | 登录 | 全部标为已读 |
| `PUT` | `/api/users/me/notifications/{id}/read` | 登录 | 单条标为已读 |
| `DELETE` | `/api/users/me/notifications/{id}` | 登录 | 删除单条 |
| `DELETE` | `/api/users/me/notifications` | 登录 | 清空全部 |

通知条目典型字段：`id`、`action_type`、`brief`、`target_id`、`comment_id`、`is_read`、`created_at`。

---

## 5. 帖子

### 5.1 列表与分类

```
GET /api/posts
```

权限：`公开`

常用查询参数：

| 参数 | 说明 |
|---|---|
| `q` | 关键词 |
| `category_id` / `category` | 按板块筛选 |
| `post_type` | 内容类型（如普通帖 / 资讯） |
| `tag` | 标签 |
| `author` | 按作者 |
| `time_range` | `week` / `month` / `year` |
| `sort_by` | `latest` / `hot` / `comments` / `relevance` |
| `page` / `size` | 分页（`size` 上限 200） |

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/posts/categories` | 板块列表 |
| `GET` | `/api/posts/latest-news` | 最新资讯 |
| `GET` | `/api/posts/feed/following` | 关注动态（需登录） |
| `GET` | `/api/posts/{id}/related` | 相关文章 |
| `GET` | `/api/posts/{id}/edits` | 编辑历史 |
| `GET` | `/api/posts/stats/public` | 公开统计 |
| `GET` | `/api/search/suggest?q=` | 搜索建议 |

### 5.2 详情

```
GET /api/posts/{id}
```

权限：`公开`（登录后会附带点赞、收藏等个人状态）

响应典型字段：`id`、`title`、`content_md`、`content_html`、`cover_image`、`image_urls`、`tags`、`author_*`、`view_count`、`like_count`、`comment_count`、`is_liked`、`is_collected`、`created_at`、`toc`、`comment_policy`。

`image_urls` 是九宫格相册（字符串数组，最多 10 项），按发布时的顺序排列；为空或缺失表示无相册。

### 5.3 发帖与编辑

```
POST /api/posts
```

权限：`登录`

```json
{
  "title": "标题",
  "content_md": "正文（Markdown）",
  "category_id": 1,
  "post_type": "post",
  "status": "published",
  "comment_policy": "open",
  "tags": ["标签A"],
  "image_urls": ["/uploads/.../a.webp"]
}
```

| 字段 | 说明 |
|---|---|
| `status` | `published` / `draft` / `scheduled` |
| `comment_policy` | `open` / `member_only` / `closed` |
| `image_urls` | 九宫格相册，最多 10 张；与正文插图合计不超过 10 张 |
| `scheduled_at` | 定时发布时间（ISO 8601，UTC） |
| `poll` | 随帖投票（可选） |

相关接口：

| 方法 | 路径 | 说明 |
|---|---|---|
| `PUT` | `/api/posts/{id}` | 编辑自己的帖子（字段同创建，可只传需要改的） |
| `DELETE` | `/api/posts/{id}` | 删除自己的帖子 |
| `POST` | `/api/posts/draft/save` | 保存草稿 |
| `GET` | `/api/posts/drafts` | 草稿列表 |
| `GET` | `/api/posts/draft/latest` | 最近一份草稿（含 `image_urls`） |
| `GET` | `/api/posts/series/all` | 合集列表 |
| `POST` | `/api/posts/series` | 创建合集 |
| `POST` | `/api/posts/series/{id}/items` | 往合集加文章 |

> 九宫格相册有**每周发布次数限制**，超出时返回 `429`/`400` 并附说明；草稿阶段不受影响。

### 5.4 图片上传

```
POST /api/posts/upload-image
Content-Type: multipart/form-data
```

权限：`登录`

| 字段 | 类型 | 说明 |
|---|---|---|
| `file` | file | 单张图片 |

响应：

```json
{ "url": "/uploads/2026/11/<随机文件名>.webp" }
```

拿到 `url` 后：

- 插入正文：`![图片](/uploads/...)`
- 或放进 `image_urls` 数组作为九宫格

每次请求只上传一张；批量上传请在客户端排队。上传有配额，超出返回 `429`。

### 5.5 互动

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| `POST` | `/api/posts/{id}/like` | 登录 | 点赞 / 取消（切换式） |
| `POST` | `/api/posts/{id}/collect` | 登录 | 收藏 / 取消 |
| `GET` | `/api/polls/post/{post_id}` | 公开 | 帖子投票详情 |
| `POST` | `/api/polls/{poll_id}/vote` | 登录 | 投票 |
| `GET` | `/api/reactions/summary?target_type=&target_id=` | 公开 | 表情反应汇总 |
| `GET` | `/api/reactions/batch` | 公开 | 批量查询 |
| `POST` | `/api/reactions/toggle` | 登录 | 添加 / 取消表情反应 |

### 5.6 评论

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| `GET` | `/api/comments/post/{post_id}?page=1&size=20` | 公开 | 评论列表（含楼中楼 `replies`） |
| `POST` | `/api/comments` | 登录 | 发表评论 |
| `POST` | `/api/comments/{id}/like` | 登录 | 评论点赞 / 取消 |
| `DELETE` | `/api/comments/{id}` | 物主 | 删除自己的评论 |

发表评论请求：

```json
{
  "post_id": "<uuid>",
  "content": "评论内容（可为空，见下）",
  "parent_id": null,
  "reply_to_user_id": null,
  "is_anonymous": false,
  "image_url": null,
  "image_kind": null
}
```

| 字段 | 说明 |
|---|---|
| `parent_id` | 回复某条评论时填它的 id；楼中楼会平铺到所属主楼下 |
| `reply_to_user_id` | 指定被回复的人，用于生成正确的通知 |
| `content` | 允许为空字符串，**但此时必须提供 `image_url`** |
| `image_url` | 单条评论最多一张图 |
| `image_kind` | `photo` 或 `sticker` |

评论按时间正序返回；主评论「精选优先 → 时间正序」，楼中楼一律时间正序。

> 回复时同时 `@` 被回复者不会重复推送两条通知，客户端无需额外去重。

---

## 6. 聊天

### 6.1 私聊

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| `GET` | `/api/chat/unread-count` | 登录 | 总未读数 |
| `GET` | `/api/chat/conversations` | 登录 | 会话列表 |
| `POST` | `/api/chat/conversations` | 登录 | 与指定用户建立/获取会话 |
| `GET` | `/api/chat/{conv_id}/messages?page=1&size=50` | 登录 | 历史消息（新的在后） |
| `POST` | `/api/chat/{conv_id}/messages` | 登录 | 发送消息 |
| `POST` | `/api/chat/conversations/{conv_id}/read` | 登录 | 标记已读 |
| `POST` | `/api/chat/messages/{msg_id}/recall` | 物主 | 撤回自己的消息 |
| `DELETE` | `/api/chat/conversations/{conv_id}` | 登录 | 删除会话 |
| `DELETE` | `/api/chat/conversations/{conv_id}/messages` | 登录 | 清空会话消息 |

发送消息：

```json
{
  "content": "你好",
  "client_msg_id": "<客户端生成的去重 id>",
  "reply_to_message_id": null
}
```

| 字段 | 说明 |
|---|---|
| `content` | 文本；若整条内容是一张图片 URL，则视为图片消息 |
| `client_msg_id` | 幂等键，防止弱网重复发送 |
| `reply_to_message_id` | 引用回复，服务端会生成引用快照 |

### 6.2 群聊

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| `GET` | `/api/chat/groups` | 登录 | 群列表 |
| `GET` | `/api/chat/groups/quota` | 登录 | 建群额度 |
| `POST` | `/api/chat/groups` | 登录 | 建群 |
| `PUT` | `/api/chat/groups/{room_id}` | 群主/管理员 | 修改群资料、公告、头像 |
| `POST` | `/api/chat/groups/{room_id}/join` | 登录 | 加入公开群 |
| `POST` | `/api/chat/groups/{room_id}/apply` | 登录 | 申请入群 |
| `POST` | `/api/chat/groups/{room_id}/invite` | 登录 | 邀请成员 |
| `POST` | `/api/chat/groups/{room_id}/leave` | 登录 | 退群 |
| `GET` | `/api/chat/groups/{room_id}/members` | 登录 | 成员列表 |
| `GET` | `/api/chat/groups/{room_id}/messages?page=1&size=50` | 登录 | 群历史消息 |
| `POST` | `/api/chat/groups/{room_id}/messages` | 登录 | 发群消息 |
| `POST` | `/api/chat/groups/{room_id}/read` | 登录 | 标记已读 |
| `POST` | `/api/chat/groups/{room_id}/messages/{msg_id}/recall` | 物主 | 撤回自己的群消息 |

群资料字段：`name`、`description`、`announcement`、`avatar_url`。

> 成员管理（踢人、转让群主、改成员角色、审批入群）属于群主自治操作，按需实现；本文档不展开，第三方客户端可只做「加入 / 发言 / 查看」。

### 6.3 实时通道（WebSocket）

```
wss://<站点域名>/api/chat/ws
```

**鉴权方式**：通过 WebSocket 子协议头传递，不要把令牌放在 URL 里：

```
Sec-WebSocket-Protocol: access_token, <access_token>
```

握手失败会以 `4001` 关闭。

上行消息（JSON）：

| `type` | 用途 | 主要字段 |
|---|---|---|
| `ping` | 心跳 | — |
| `typing` | 输入中 | 会话 / 房间 id |
| `join_group` | 订阅群实时消息 | `room_id` |
| `leave_group` | 取消订阅 | `room_id` |
| 发送消息 | 发送私聊/群聊消息 | `content`、`client_msg_id`、`room_id` / `conversation_id`、`reply_to_message_id` |

下行消息（JSON）：

| `type` | 用途 |
|---|---|
| `pong` | 心跳响应 |
| `ack` | 发送确认，含 `client_msg_id`、`msg_id`、`seq_id`、`created_at` |
| `new_msg` | 收到私聊消息 |
| `group_msg` | 收到群消息 |
| `group_members_changed` / `group_joined` / `group_left` / `group_closed` / `group_recall` / `group_kicked` | 群事件 |
| `error` | 错误，含 `detail` |

推荐实现：

1. HTTP 拉取历史消息（第一页 = 最新一页）
2. WS 订阅实时增量
3. 收到 `ack` 后把本地乐观消息替换成真实 `msg_id`
4. 向上翻历史时保持用户当前阅读位置，不要自动跳到底部

### 6.4 消息内容约定

- 整条 `content` 是本站图片 URL 时，按图片消息渲染（不带气泡）
- 整条 `content` 是本站自定义表情 URL 时，按表情包渲染（裸图）
- `reply_to_id` / `reply_sender` / `reply_snippet` 表示引用快照，即使原消息被撤回也保留
- 列表预览中请把图片地址显示为「[图片]」或「[表情]」，不要直接展示地址

---

## 7. 自定义表情包

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| `GET` | `/api/stickers/mine` | 登录 | 我的表情列表（含数量上限） |
| `POST` | `/api/stickers/upload` | 登录 | 上传表情（`multipart/form-data`，字段名 `file`） |
| `POST` | `/api/stickers/collect` | 登录 | 收藏别人发的表情，请求 `{ "url": "/uploads/stickers/..." }` |
| `DELETE` | `/api/stickers/{id}` | 物主 | 删除自己的表情 |

- 表情数量有上限，超出返回错误
- 删除只移除自己的收藏记录，不影响已发出的历史消息
- 表情发送有频率限制，避免刷屏

---

## 8. 勋章与成就

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| `GET` | `/api/achievements/catalog` | 公开 | 勋章目录 |
| `GET` | `/api/achievements/me` | 登录 | 我获得的勋章 |
| `GET` | `/api/achievements/user/{user_id}` | 公开 | 某用户勋章 |
| `GET` | `/api/achievements/wall/{user_id}` | 公开 | 勋章墙（含彩蛋） |
| `POST` | `/api/achievements/unlock` | 登录 | 上报彩蛋解锁 |

彩蛋为「共同解锁才可见」：只有双方都解锁了同一个彩蛋，才能在对方勋章墙看到它的名称；否则显示为 `???`。

---

## 9. 其他公开能力

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| `POST` | `/api/feedbacks` | 登录 | 提交反馈 |
| `GET` | `/api/feedbacks` | 公开 | 反馈列表 |
| `POST` | `/api/feedbacks/{id}/upvote` | 登录 | 反馈点赞 |
| `POST` | `/api/rules/endorse` | 登录 | 认同社区公约 |
| `DELETE` | `/api/rules/endorse` | 登录 | 撤回认同 |
| `GET` | `/api/links` | 公开 | 友情链接列表 |
| `POST` | `/api/links/apply` | 登录 | 申请友链 |

---

## 10. 典型接入流程

### 10.1 App 首次启动

```
1. POST /api/auth/login            → 拿到 access_token（并保存 Cookie）
2. GET  /api/auth/me               → 拿到当前用户资料
3. GET  /api/posts?page=1          → 首页信息流
4. GET  /api/users/me/notifications/unread-count → 红点
```

> 账号来自网页端注册；App 不需要、也不应实现注册页。

### 10.2 发一篇带九宫格的帖子

```
1. 逐张 POST /api/posts/upload-image  → 收集 url[]
2. POST /api/posts  { title, content_md, image_urls: url[], status: "published" }
3. GET  /api/posts/{id}              → 按 image_urls 渲染 1/2/3 列网格
```

### 10.3 发一条带图片的评论

```
1. POST /api/posts/upload-image      → { url }
2. POST /api/comments  { post_id, content: "", image_url: url, image_kind: "photo" }
```

### 10.4 进入群聊

```
1. GET  /api/chat/groups/{id}/messages?page=1&size=50   → 最新一页
2. 建立 WebSocket，join_group 订阅
3. 收到 group_msg 追加；发送后等 ack 替换乐观消息
4. 向上翻页时保持当前阅读位置
```

---

## 11. 兼容性说明

- 本文档描述的是**对外契约**，字段可能增加，但已有字段的语义保持稳定
- 客户端应对未知字段做忽略处理，不要因为多出字段而解析失败
- 新增能力会以新端点形式提供
- 若接口返回 `401`，先尝试一次 `POST /auth/refresh`，成功则重试原请求；仍失败再引导用户登录
- 示例中的 UUID、用户名、图片地址均为占位值，不代表真实数据

---

## 12. 使用条款（建议接入方遵守）

1. 不得利用接口进行刷量、灌水、爬取用户隐私或绕过频率限制
2. 不得在客户端内提供站点管理、版务、审核相关功能
3. 用户上传的内容归属与站点规则一致，客户端需提供举报入口或引导用户到网页端反馈
4. 请合理缓存公开数据，避免高频轮询
