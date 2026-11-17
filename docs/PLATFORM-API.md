# QLTeacher 平台接口笔记

本文记录 `courseflow-qlteacher` 使用的公开网页接口，便于后续维护。接口可能随平台升级变化；模块会通过 `platform_protocol_changed` 暴露无法识别的响应，而不是猜测。

## 主机

| 主机 | 用途 |
| --- | --- |
| `passport.qlteacher.com` | 登录、刷新令牌、公钥 |
| `account.qlteacher.com` | `/api/me` 身份信息 |
| `yxjc.qlteacher.com` | 课程目录、学习入口 |
| `player.qlteacher.com` | 课程结构、活动、学习进度、测验 |
| `downloadres.qlteacher.com` | 富文本/题图资源 |

清单只声明 `qlteacher.com` 和 `*.qlteacher.com`。框架的 `cw.net.fetch` 负责 Cookie 注入、域名白名单、超时、夜间暂停和写入台账。

## 登录

### 公钥

```http
GET https://passport.qlteacher.com/api/oauth2/public-key
```

```json
{"code":200,"data":{"publicKey":"-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----"}}
```

### 密码

1. 使用 SPKI 公钥做 RSA-OAEP（SHA-256，空 label）。
2. Base64 编码密文。
3. 提交表单：

```http
POST https://passport.qlteacher.com/api/oauth2/token
Authorization: Basic d2ViOnFsdGVhY2hlcg==
Content-Type: application/x-www-form-urlencoded
X-Device-ID: <random/persisted device id>

username=<账号>&password=<RSA密文>&grant_type=password
```

`Basic d2ViOnFsdGVhY2hlcg==` 是网页公开的 OAuth 客户端标识（`web:qlteacher`），不是用户密码、Cookie 或私钥。

成功：

```json
{
  "code": 200,
  "data": {
    "access_token": "<JWT>",
    "refresh_token": "...",
    "expires_in": 7200,
    "token_type": "Bearer"
  }
}
```

账号或密码错误返回 HTTP 200 + `code:23001`。安全验证相关常见码：`23002`（滑块/验证码）、`23007`（短信验证码）、`23013`/`23014`（第三方绑定）。模块把这些情况作为登录失败/额外验证处理。

### 刷新

```http
POST https://passport.qlteacher.com/api/oauth2/token
Authorization: Basic d2ViOnFsdGVhY2hlcg==
X-Device-ID: <same device id>
Content-Type: application/x-www-form-urlencoded

refresh_token=<refresh_token>&grant_type=refresh_token
```

### JWT 身份

access token 的 payload 通常包含：

```json
{"sub":"10001","name":"姓名","exp":1700000000}
```

模块用 `sub` 作为 `account_raw`，`name` 作为 `display_name`。如果缺失则调用 `account.qlteacher.com/api/me`。

## 课程目录

### 我的课程

```http
GET https://yxjc.qlteacher.com/api/lesson/lessons/my?projectId=cz2026
```

`data` 是专题/分组数组，每组包含 `lessons`。课程关键字段：

```json
{
  "id": "lesson id",
  "name": "课程名",
  "mustLearn": true,
  "allowLearn": true,
  "external": "",
  "lessonLearnStatus": {
    "status": 0,
    "lastLearnActId": "activity id",
    "lastLearnActName": "上次学习活动",
    "lastLearnTime": 1700000000
  }
}
```

`status`：`0` 未完成、`1` 已完成。模块把 `external` 非空的课程标记为不可打开。

### 学习入口

```http
GET https://yxjc.qlteacher.com/api/lesson/learning/url?projectId=cz2026&lessonId=<lesson id>
```

`data` 是播放器 URL，例如：

```text
https://player.qlteacher.com/learning/<course token>
```

模块从路径 `/learning/<token>` 提取播放器令牌。

### 播放器课程结构

```http
GET https://player.qlteacher.com/api/learning/<course token>/course
Authorization: Bearer <access_token>
```

```json
{
  "code": 200,
  "data": {
    "course": {"courseId": "...", "courseName": "..."},
    "learnMode": 2,
    "finished": false,
    "finishedActs": {"activity id": 1700000000},
    "lastLearnAct": "activity id",
    "sections": [
      {
        "id": "section id",
        "title": "第一章",
        "extendedResource": false,
        "courseSessions": [
          {
            "id": "activity id",
            "title": "1.1 视频",
            "sessionType": "video",
            "mustLearn": 1,
            "status": 0,
            "standard": 600,
            "ext": {
              "studyTime": 600,
              "duration": 120,
              "resourceItems": []
            }
          }
        ]
      }
    ],
    "plusSections": {
      "extendedResource": true,
      "courseSessions": []
    }
  }
}
```

`sessionType` 取值：

| 值 | 公共 `Unit.kind` | 处理 |
| --- | --- | --- |
| `video` | `video` | 自动学习 |
| `teletext` / `txt` | `reading` | 自动学习 |
| `doc` | `document` | 自动学习 |
| `resource` | `document` | 逐项打开 |
| `link` | `reading` | 自动学习（平台提供时长时） |
| `exam` | `empty` | 进入课程测验 |
| `homework` / `assignment` | `empty` | 不支持，需官方页面 |

`learnMode`：`0` FREE、`1` RELAX、`2` STRICT。

`status`：`0` 未完成、`1` 已完成、`2` 学习中。模块同时检查 `finished`、`finishedActs` 和 `status`。

## 活动详情

```http
GET https://player.qlteacher.com/api/learning/<course token>/activity/<activity id>
Authorization: Bearer <access_token>
```

```json
{
  "code": 200,
  "data": {
    "activity": {
      "id": "...",
      "title": "...",
      "sessionType": "video",
      "status": 0,
      "ext": {
        "studyTime": 600,
        "duration": 120,
        "examItems": []
      }
    },
    "status": 0,
    "duration": 120,
    "actToken": "...",
    "learnMode": 2,
    "updateDurationInterval": 60,
    "courseStatInfo": {"finishedActs": {}},
    "userAnswers": []
  }
}
```

`actToken` 用于学习进度写入，每次获取最新值。模块在每步开始时重新读取活动，避免使用过期令牌。

## 学习进度

视频：

```http
PUT https://player.qlteacher.com/api/learning/<course token>/duration/video/<activity id>/<actToken>/<seconds>
Authorization: Bearer <access_token>
Content-Type: application/json

{}
```

带 `?_ignore_error=true` 时平台用统一错误包返回。

其他类型：

```text
PUT .../duration/doc/<activity id>/<actToken>/<seconds>
PUT .../duration/txt/<activity id>/<actToken>/<seconds>
PUT .../duration/link/<activity id>/<actToken>/<seconds>
PUT .../duration/resource/<activity id>/<resource item id>
```

`seconds = -1` 表示请求完成。响应通常包含 `actStatus`：`0` 未完成、`1` 已完成。模块不会只信 `actStatus`，会重新 `GET activity` 确认。

资源活动没有时长参数：播放器在同一资源条目首次点击时调用一次 `duration/resource`，并在本地记录 `durationContent[itemId]`。模块按顺序打开每个条目，再回读完成状态。

## 课程测验

测验是 `sessionType: "exam"` 的活动，题目在：

```text
activity.ext.examItems[]
```

题目字段：

```json
{
  "id": "q1",
  "type": "single",
  "itemType": "question",
  "title": "题干 / FastDFS 路径",
  "workDuration": 0,
  "options": [
    {"id": "a", "title": "选项 A", "right": false}
  ],
  "answerDesc": "解析",
  "ext": {"titleType": "fastdfs"}
}
```

题型：`single`、`multiple`、`trueorfalse`、`section`。公共 DTO 映射：

- `single` → `single`
- `multiple` → `multiple`
- `trueorfalse` → `judge`，选项规范化为 `true`/`false`
- `section` 不是题目，过滤
- 其他 → `unsupported`

`itemType.toLowerCase() === "section"` 或 `type === "section"` 均过滤。

### 已作答/已公布答案

活动响应中的 `userAnswers`：

```json
[
  {"questionId":"q1","answer":"b","correct":true,"rightAnswer":"b"}
]
```

`options[].right` 和 `rightAnswer` 都可以提供正确答案。模块只在平台已提交/已公布时使用它们；新开卷不会猜测答案。

### 交卷

```http
POST https://player.qlteacher.com/api/learning/<course token>/test
Authorization: Bearer <access_token>
Content-Type: application/json

{
  "token": "<course token>",
  "activityId": "<activity id>",
  "answers": [
    {"questionId": "q1", "answer": "b"},
    {"questionId": "q2", "answer": "a,c"},
    {"questionId": "q3", "answer": "t"}
  ]
}
```

- 单选/判断题：选项 id。
- 多选：选项 id 用逗号连接。
- 判断题公共 DTO 使用 `true`/`false`，交卷时通过保存的选项映射转回平台 id。
- 交卷响应示例：

```json
{
  "code": 200,
  "data": {
    "actStatus": 1,
    "answers": {
      "q1": {"userAnswer":"b","correct":true,"rightAnswer":"b"}
    }
  }
}
```

模块把请求意图先写入加密状态；不确定结果只回读，不重发。回读以活动 `status/finishedActs` 为确认依据，并返回原始 `attempt_id`。

## 公共 DTO 注意点

- `Question.kind` 只使用已验证的 `single`/`multiple`/`judge`；其他题型标为 `unsupported`。
- 判断题公共选项固定为 `true`/`false`，与 Courseflow 的题库格式一致。
- 题干和选项经 HTML 清洗，图片从 `<img src>` 提取并限制在 `*.qlteacher.com`。
- FastDFS 题干/选项通过 `downloadres.qlteacher.com` 读取原始 HTML。
- 平台没有草稿接口，所以 `exam.write` 的 `draft` 阶段只返回本地 `done` 且 `draft_supported:false`。

## 参考

- 公开参考脚本：<https://github.com/plsy1/qlteacher>（MIT）
- 当前网页资源：`yxjc.qlteacher.com/main-*.js`、`player.qlteacher.com/main-*.js`、`passport.qlteacher.com/assets/*.js`
