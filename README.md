# courseflow-qlteacher

Courseflow 平台模块：山东省教师教育网 / QLTeacher（`yxjc.qlteacher.com`）。

这是一个独立模块仓库，不修改 `courseflow-framework` 或 `courseflow-webui`，只实现模块 API v1。

## 已实现

| 能力 | 说明 |
| --- | --- |
| 账号密码登录 | 使用 QLTeacher Passport 的 RSA-OAEP（SHA-256）密码加密；令牌加密保存在模块状态中，不保存密码 |
| 登录保活 | access token 临近过期时用 refresh token 刷新；框架每 5 分钟调用一次 `auth.keepalive` |
| 课程列表 | 读取 `project_id` / `project_ids` 下的 `lessons/my`，按学习专题展开课程 |
| 课程目录 | 读取播放器课程结构，映射章节、视频、图文、文档、资源、链接、测验 |
| 自动学习 | 视频 / 图文 / 文档 / 链接按真实时间推进，支持框架的 `speedup`（最高 1.5 倍） |
| 资源活动 | 逐个打开资源条目并回读完成状态 |
| 视频弹题 | 平台下发正确答案时直接使用；没有答案时返回 `needs_ai`，交给工作台模型或人工补答 |
| 课程测验 | `catalog.papers` / `exam.open` / `exam.write` / `exam.readback`，先回读平台确认再标记完成 |
| 题库记忆 | 交卷后把平台判定为正确的答案写入框架题库；开卷时读取已确认答案自动填充 |
| 执行记录 | 通过框架通用任务事件显示，模块不另建页面 |

工作台中的「课程学习」和「课程测验」是分开的：测验不会出现在自动学习队列里，需要在「课程测验」页签选择后执行。

## 设置

模块设置是 JSON 对象，保存后模块重启：

```json
{
  "project_id": "cz2026",
  "project_ids": ["cz2026"],
  "chunk_seconds": 60,
  "course_cache_seconds": 900,
  "request_timeout_ms": 12000,
  "study_verify_attempts": 6
}
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `project_id` | `cz2026` | 课程列表使用的项目编号，来自 URL `/project/<project_id>/lesson/learn` |
| `project_ids` | `[]` | 可选，额外合并的项目；`project_id` 会自动加入 |
| `chunk_seconds` | `60` | 每次落盘的学习秒数，10–60；等待时间由 1x/1.5x 决定 |
| `course_cache_seconds` | `900` | 播放器课程令牌缓存时间 |
| `request_timeout_ms` | `12000` | 单次平台请求预算，5000–25000 |
| `study_verify_attempts` | `6` | 完成写入后回读未确认时的重试次数，超过后转人工 |

例如要同时处理两个研修项目：

```json
{
  "project_id": "cz2026",
  "project_ids": ["cz2026", "xx2026"]
}
```

## 安装与连接

1. 在 Courseflow 管理界面的「平台模块」中安装本目录（目录内包含 `courseflow.module.json`、`index.mjs` 和 `src/`）。
2. 在「平台连接」中添加 QLTeacher 账号，输入山东省教师教育网账号和密码。
3. 如果平台要求短信、滑块或额外安全验证，模块会返回登录失败。请先在官方网页完成验证或改用平台支持的登录方式；本模块不会绕过验证码。
4. 登录后即可在课程工作台查看课程目录、创建学习和测验任务。

运行环境只需要 Node.js（框架已经要求）。模块没有 npm 运行时依赖。

## 学习与测验行为

- 学习步骤使用平台播放器的 `duration/video|doc|txt|link` 接口。首次步骤先等待一个学习块，随后每块落盘一次；暂停期间不会计入学习时间。
- `speedup` 只会缩短等待时间，保存的课程秒数仍是真实学习秒数，最多 1.5 倍。
- `trial`（短时试跑）只推进指定秒数，不会把课程标记为平台完成。
- 课程测验没有草稿接口，因此 `exam.write` 的 `draft` 阶段只在本地返回 `draft_supported:false`，不会发请求。只有确认交卷或勾选自动提交后才会调用平台 `POST /test`。
- 交卷前先把意图写入加密状态；请求结果未知时只允许回读，不会自动重发。
- 回读以 `GET activity` 的平台状态为准，返回原始 `attempt_id`。确认后才写入题库和任务完成状态。
- QLTeacher 的学习活动存在互斥（同一账号不能同时学习多个活动）。遇到 `learnMultiAct` 时任务会暂停，不会并发重试。

### 视频弹题

播放器下发的视频弹题通常带有正确选项。模块会把这些答案作为 `correct_answer` 返回，工作台可以直接记忆并继续。若平台没有下发答案，则返回 `needs_ai`：

- 配置模型后会生成答案并继续；
- 未配置模型时任务暂停，在任务详情中人工补答。

弹题只影响本地播放进度，不会向平台单独提交答案。

## 暂不支持

以下功能明确不在本版本范围内，遇到时会暂停或跳过，不会伪造成功：

- 作业（homework）、课程作业/考试之外的外部作业；
- 国培等外部课程（`external` 课程只显示不可学习）；
- 直播/见面课、签到、问答区、笔记、评价；
- 二维码登录、验证码识别、短信验证码；
- 课程测验重做（`exam.redo` 返回 `unsupported_operation`，如需重考请在官方页面操作）；
- 平台未公开的分数、排名或学习行为统计。

## 真实账号验收

模块自带无网络的模拟宿主测试：

```bash
npm test
```

真实账号冒烟测试默认只读（登录、课程、目录、测验列表）：

```bash
QL_USERNAME='账号' QL_PASSWORD='密码' npm run live
```

冒烟脚本默认脱敏：不输出姓名、账号 ID、课程/单元名称或题干选项；失败时只显示错误类别，不显示详情。显式加 `--verbose` 才会显示课程内容和脱敏后的错误/模块 stderr。模块子进程只继承 `PATH`、`TZ` 和模块设置，不继承 `QL_USERNAME` / `QL_PASSWORD`。

只处理一个可自动学习的单元（会写入真实平台进度）：

```bash
QL_USERNAME='账号' QL_PASSWORD='密码' npm run live -- --study-one
```

读取第一份测验题目（默认只显示题型和数量；加 `--verbose` 才显示题干选项）：

```bash
QL_USERNAME='账号' QL_PASSWORD='密码' npm run live -- --exam-open
QL_USERNAME='账号' QL_PASSWORD='密码' npm run live -- --exam-open --verbose
```

可用环境变量：`QL_PROJECT_ID`（默认 `cz2026`）、`QL_LESSON_ID`（指定课程）。

平台会对连续错误密码做限流。真实账号测试请使用正确凭据；不要用真实账号反复试错。

建议真实账号验收顺序：

1. 登录成功，平台连接显示姓名；
2. 课程列表条目与官方 `/project/cz2026/lesson/learn` 一致；
3. 打开一门课程，目录章节和官方播放器一致；
4. 对 1 个短视频执行 `--study-one`，完成回读后官方进度增加；
5. 在「课程测验」中打开一份测验，确认题目、选项和官方页面一致；
6. 选择自动提交后交卷，确认回读结果为平台已提交，再检查官方成绩页。

## 开发

```bash
npm test
```

测试使用真实 RSA 密钥对验证密码加密，并模拟 QLTeacher 的登录、课程、播放器、学习进度、测验提交与回读接口。测试覆盖：

- 登录成功/失败、令牌刷新；
- 课程和章节映射、测验/扩展资源可选性；
- 真实时间节奏、1.5 倍速、偏移落盘、完成后回读；
- 视频弹题；
- 资源逐项打开；
- 测验草稿、提交去重、回读确认、得分和题库写入；
- 未知方法和重做错误。

平台接口细节见 [docs/PLATFORM-API.md](docs/PLATFORM-API.md)。

## 安全与隐私

- 不保存账号密码；登录密码只在单次登录交换中使用。
- access/refresh token、播放器令牌、作答快照和交卷意图存放在框架的加密 `cw.state` 中。
- 学习写入使用 `save_study` 阶段，交卷使用 `submit` 阶段，遵守框架的夜间暂停、任务代次和网络白名单。
- 不读取 Cookie 容器，不记录完整页面、令牌或带凭据的 URL。
- 自动测试使用模拟宿主和临时 RSA 密钥，不连接真实账号；真实账号冒烟脚本默认脱敏，只有显式 `--verbose` 才输出课程内容。
- 仅安装可信模块；二进制模块和浏览器脚本不属于本仓库。

## 许可证

MIT。平台接口来自公开网页和公开参考脚本，详见 [NOTICE.md](NOTICE.md)。
