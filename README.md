# dsh-minimax-asr

把 MiniMax 语音识别（`asr-1.0`）与语音合成（`speech-2.8-hd`）接成 **DeepSeek Harness 全局插件**：
一个给模型用的 `transcribe_audio` 工具、一张设置卡片、输入框里的语音输入按钮，
以及**任务结束后自动把结果念给你听**的喇叭。

<img width="1900" height="899" alt="20260914054918" src="https://github.com/user-attachments/assets/b2db5426-f417-4a48-9e13-e4f4c196f4a2" />



中文 | [English](README.en.md) | [更新日志](CHANGELOG.md) | **v0.2.0**

## 它提供什么

| 面 | 内容 |
| --- | --- |
| 工具 | `transcribe_audio(path, language?, response_format?, timestamp_level?)` |
| 接口 | `POST <baseURL>/v1/speech_to_text`（multipart，默认 `model=asr-1.0`） |
| 凭据 | 默认引用 `MINIMAX_API_KEY`，每次请求经 credentials seam 重新解析（可热轮换） |
| 设置 | 命名空间 `minimax-asr`：`apiKeyEnv`、`baseURL`、`model`、`responseFormat`、`language`、`timestampLevel`、`maxRecordSeconds`、`maxFileMB`、`timeoutMs`、`speakEnabled`、`ttsModel`、`ttsVoice`、`ttsSpeed`、`speakMaxChars`、`voiceLoop` |
| 卡片 | 由 `client/client.js` 渲染在「设置 → 插件」里 |
| 语音输入 | 输入框工具行的麦克风按钮：录音 → 转写 → 追加进草稿 |
| 语音播报 | 每轮任务结束时，宿主把该轮回复推给浏览器，由喇叭念出来（可一键静音） |
| 实时对话 | 输入框工具行的「对话」按钮：念完回复自动开麦，你停下来就自动转写并发送，全程不用点按钮 |

MiniMax 接受的格式：`wav`、`aiff`、`flac`、`m4a`/`alac`、`mp3`、`aac`、`opus`、`ogg`。
**不接受**裸 PCM 与 `webm`。单个文件不超过 **500 秒 / 50 MB**，计费按返回的 `duration`。

`response_format` 可选 `json`（文本 + 时长）、`verbose_json`（额外给出说话人分离的带时间戳分段）、
`srt`、`vtt`；`timestamp_level` 可选 `sentence`（默认）或 `word`，对 `json` 无效。

## 安装

**从 GitHub 安装**（推荐）：

```sh
dsh plugin --profile web add github:moluyao/dsh-minimax-asr
```

它会作为 bundle 层写进 profile，**重启 `dsh` 后生效**。

**从本地 checkout 安装**（开发时用，可热加载）：

```sh
dsh plugin --profile web add <本仓库路径>
```

然后在 profile 的补丁层（`$DSH_HOME/profiles/web/cordis.patch.yml`）里激活：

```yaml
- insert:
    - id: minimax-asr
      name: 'dsh-minimax-asr'
      config:
        apiKeyEnv: MINIMAX_API_KEY
        baseURL: https://api.minimaxi.com
        model: asr-1.0
```

**只保留一个激活点。** 只要包声明了 `dsh.bundle`，`dsh plugin add` 就会把它同时写进
`dsh.profile.bundles`，而 bundle 层会再插一行 `id: minimax-asr` —— 两行并存会让插件被挂载两次
（同一个工具名注册两遍）。所以本机这种"补丁层激活"的用法要把包只当依赖：若之后 `dsh plugin`
命令把 bundle 行加了回来，删掉 `cordis.patch.yml` 里的 insert 行即可。

宿主半（工具 + 设置命名空间）会随补丁层热加载；宿主的客户端模块注册表会在每次插件挂载时重扫，
所以两半都能即时生效，刷新页面即可拿到重新组合的启动图。

## 密钥

密钥永远不进配置文件，而是每次请求经 credentials seam 解析（默认引用 `MINIMAX_API_KEY`），
所以存在 `~/.dsh/.credentials.yaml` 里、或导出在环境变量里的值都能直接复用：

```sh
MINIMAX_API_KEY=sk-...
```

## 语音输入（浏览器）

| 操作 | 发生什么 |
| --- | --- |
| 点一下 | `getUserMedia` 打开麦克风，按钮变红并计时（120 秒自动停止） |
| 再点一下 | 停止录音，解码并重新编码为 16 kHz 单声道 WAV，POST 到 `/minimax-asr/transcribe` |
| 返回 | 识别文本追加进输入框已有内容之后，每条转写只插入一次 |

Chrome 只录 `webm/opus`，而接口**不接受** webm —— 所以浏览器半会先解码、重建成 WAV 再上传，
上传上限与工具共用同一个 `maxFileMB`。首次使用会弹一次麦克风授权（按来源记一次）；
被拒绝时原因会显示在按钮的悬停提示里，且麦克风轨道总会被释放。

**录音时长上限**：默认 **300 秒（5 分钟）**，可在「设置 → 插件 → MiniMax 语音识别 → 录音时长上限（秒）」
里改成 10–500 之间的任意值，改完**下一次录音**即生效（录制中不会中途被新值截断）。
录制时按钮显示 `已录 / 上限`（例如 `1:23 / 5:00`），到点自动停止并转写。

要注意 MiniMax 的**硬上限是每个文件 500 秒（约 8 分 20 秒）**，超过会直接返回 400、不会截断 ——
所以 **10 分钟无法一次请求完成**，插件最多给到 500 秒。体积上不是问题：
16 kHz 单声道 16-bit WAV 约 32 KB/s，500 秒 ≈ 16 MB，仍在 50 MB 之内。

## 语音播报（宿主 → 浏览器）

任务跑完时你往往不在看屏幕，所以**每一轮结束都会用喇叭念一句**。关键在于：
**念出来的那句话是这一轮专门为耳朵写的一句，而不是把正文截一段念出来。**

| 环节 | 发生什么 |
| --- | --- |
| 命名 | 模型在每轮结束前调用 `announce_speech`，给出 **1–2 句口语简报**（结论 + 关键数字 + 需要你决定的那件事）；正文完全不变 |
| 宿主 | 订阅 `session/event`，在 `turn/end` 时把这句话推给浏览器；`announce_speech` 传 `silent: true` 的那一轮就不出声 |
| 推送 | 经 `GET /minimax-asr/events`（SSE）推给浏览器，一张 `announce` 帧一轮；帧上带 `source`，标明来自 `spoken-line` / `reply-head` / `silent` |
| 浏览器 | 用 `speech-2.8-hd` 合成（`POST /minimax-asr/speak`）后播放；多条会排队，不会叠着念 |
| 静音 | 输入框工具行的喇叭按钮（在麦克风右边）一键开关；关掉会立刻掐掉正在念的那句 |

**兜底**：某一轮如果没有调用 `announce_speech`，宿主只念正文的**第一句**（结论通常就在那里），
不会把正文念一遍。任何情况下都**不会**出现"后面还有内容我就不念了"这种话 ——
播报如果长到需要道歉，说明它没凝练，正确做法是重写成短句，而不是念一半再道歉。
超过 `speakMaxChars`（默认 **80** 字）在最近的句子边界截断，**不附加任何说明**。

`announce_speech` 还带一道防线：超过 600 字的"播报"会被**拒绝并说明原因**（大意是"这是一份报告的摘要，
不是一句播报"），逼着调用方真正凝练；被拒绝时那一轮退回正文首句。

音色默认 `male-qn-jingying`（男声·精英），现在可在卡片里**从 303 个音色中挑选**（见下），
并用「试听音色」当场听一句。宿主半还额外暴露：

| 路由 | 用途 |
| --- | --- |
| `GET /minimax-asr/events` | 播报流（SSE），浏览器半常驻订阅 |
| `POST /minimax-asr/speak` | `{ "text": "..." }` → `audio/mpeg` 字节 |

`GET /minimax-asr/diagnostics` 的返回里带 `listeners`，可以直接看到当前有几个浏览器在听播报。

**自动播放**：浏览器要求页面先有过一次用户交互才允许出声。你在这个页面里打过字，
所以通常直接就能响；万一被拦，卡片会显示「浏览器拦截了自动播放」，在页面任意处点一下即可。

## 实时对话（免手操作）

输入框工具行最右边是**对话**按钮。点一下开启，之后就不用再碰键鼠：

| 环节 | 发生什么 |
| --- | --- |
| 你在说 | 麦克风自动打开，按电平判断你什么时候说完：说到一半停顿不算，静音 1.2 秒才算一轮说完 |
| 说完 | 自动转写成 16 kHz WAV 上传、拿到文字、**直接替你发出这条消息**（不改动你手打的草稿：转写会替换草稿后提交） |
| 它思考 | 麦克风此时关闭 —— 否则会把喇叭的声音录回去 |
| 它回答 | 回复念完的那一刻，麦克风**自己重新打开**，等你下一句；轮次计数显示在按钮上 |
| 没听到声音 | 整整 30 秒没人说话就释放麦克风并暂停（按钮提示「没听到声音，点一下重新听」），不会一直占着麦克风，也不会把静音上传去浪费额度 |
| 取消/失败的那一轮 | 宿主照样推一帧空文本：浏览器不发声，但循环会重新开麦，不会卡在等待里 |

电平门限是**自适应**的：先测房间噪声，取「噪声的 3 倍」和「绝对下限 0.0025」的较大者，并设了 0.03 的上限，
所以安静的内置麦克风阵列也能用、嘈杂房间也不至于变聋。实测数值（`level`/`floor`/`gate`/`loudest`）
每秒上报一次到 `GET /minimax-asr/diagnostics`，从外面就能看出门限是否合适。

## 音色

卡片里的音色是**下拉选择**，不是手填：宿主半从 MiniMax 拉取当前账号的完整音色表
（`POST /v1/get_voice`，实测 **303 个系统音色**），按语言分组（国语 / 粤语 / 英语 / 日语 / 韩语 / …），
缓存 10 分钟。取不到时退回内置短名单，选择器照常可用。克隆音色或任何不在表里的 id，
在选择器里选「自定义音色 ID…」后手填即可。

选中的音色可以直接点**试听音色**当场听一句 —— 试听走的是**当前选择**（哪怕还没保存），
所以可以挨个试到满意再保存。实现上 `/minimax-asr/speak` 接受可选的 `voice`/`speed` 覆盖。

## 本地路由

四个路由挂在同一个受护栏的前缀下（loopback `Host`、无跨站标记、`Origin` 匹配；
这是防 DNS rebinding / 跨站的姿势，不是身份认证）：

| 路由 | 用途 |
| --- | --- |
| `POST /minimax-asr/transcribe` | 收一段录音（`audio/wav` 正文，可选 `?format=`、`?level=`、`?language=`、`?name=`），返回转写 |
| `GET /minimax-asr/events` | 播报流（SSE）：每轮结束推一张 `announce` 帧（取消的那轮文本为空，用于让循环重新开麦） |
| `POST /minimax-asr/speak` | 合成一句话（可带 `voice`/`speed` 覆盖），返回 `audio/mpeg` |
| `GET /minimax-asr/voices` | 账号的音色表（`{id, name, group}`），带缓存 |
| `GET /minimax-asr/diagnostics` | 浏览器半自报的接线状态与实测电平：`applied`、`card-registered`、`mic-registered`、`mic-rendered`、`speaker-registered`、`speech-listening`、`announce-received`、`spoke`、`voice-registered`、`voice-control-rendered`、`voice-loop-listening`、`voice-submitted`、`mic-level`（有上限、只在内存、不含机密） |
| `POST /minimax-asr/diagnostics` | 浏览器半上报这些事实的入口 |

想确认"浏览器半加载了没有、控件挂上没有、喇叭通没通"，`GET /minimax-asr/diagnostics` 是最快的答案。

## 不依赖 Harness 的测试

```sh
MINIMAX_API_KEY=... node tests/smoke.mjs <音频文件> [response_format] [timestamp_level]
MINIMAX_API_KEY=... node tests/route-smoke.mjs <音频文件>
node tests/client-smoke.mjs
node tests/installed-check.mjs <profile 目录>
```

- `tests/smoke.mjs`：加载 `lib/index.js`，用桩上下文执行 `apply`，再对真实接口跑一次工具调用。
- `tests/route-smoke.mjs`：用合成的 node 请求驱动路由 —— 覆盖全部护栏与体积拒绝、diagnostics 通道、
  一轮 `completed` 变成一张 `announce` 帧（取消的那轮保持安静、挂断后监听者归零），
  以及一次真实转写和一次真实语音合成。
- `tests/client-smoke.mjs`：按浏览器的方式加载 `client/client.js`（经典脚本调用
  `window.__ModuleLoader__.load`），在桩 React / 模块表下断言卡片渲染与它写出的 path ops，
  并把整条麦克风流水线跑通（只伪造编解码器与网络），断言上传 WAV 的文件头、采样率与采样数；
  再驱动整条播报链路（SSE 帧 → 合成请求 → 播放 → 排队 → 静音 → 中途打断 → 合成失败后恢复）。
- `tests/installed-check.mjs`：从 profile 解析**已安装**的包，断言宿主客户端扫描器需要的一切
  （`dsh.client.platform`、`./client` 字节、bundle id、每个声明的 inject、宿主半的导出形状），
  外加"只有一个激活点"这条不变量。

## 已验证

- 用 `asr-1.0` 真实转写：`json`、带词级时间戳与说话人的 `verbose_json`、`srt` —— 工具与路由两条路径都验过。
- 运行中的 Harness 里，一个新起的子 agent 在自己的工具表里看到了 `transcribe_audio` 并成功转写文件。
- 设置卡片在真实浏览器里渲染（临时 profile、同 bundle 组合）：8 个字段从命名空间取到真值、
  凭据徽标显示「已配置」、编辑后出现「未保存」、点保存后真的写入 profile 的 `settings.yaml`。
  这一轮还抓到一个真实缺陷 —— 卡片读了 `ctx.remote` 却只声明了 `remote.credentials`，
  Cordis 直接拒绝（`cannot get property "remote" without inject`）。
- 语音控件在真实会话的输入框工具行里渲染（`aria-label="用 MiniMax 语音识别听写"`、`supported: true`），
  DOM 与宿主自报的 diagnostics 双向确认。注意它只在会话绑定工作区后出现，无工作区的 hero 输入框不挂载该区域。
- 麦克风流水线（录音 → 解码 → 16 kHz 单声道 WAV → 路由 → 草稿）在 `client-smoke` 里全绿，只伪造了编解码器与网络。
- 播报链路在两端都验过：宿主侧一轮 `completed` 经真实 SSE 帧下发（`route-smoke`），
  真实 MiniMax TTS 经 `/minimax-asr/speak` 返回 33 KB `audio/mpeg`；浏览器侧整条链路（收帧 → 合成 → 播放 →
  排队 → 静音 → 打断 → 失败恢复）在 `client-smoke` 里全绿。
- 实时对话循环在 `client-smoke` 里全绿：静音 30 秒释放麦克风且不上传、说话后静音自动结束并自动提交、
  念完回复自动重新开麦、取消的那轮也会重新开麦、关掉立刻释放麦克风。
  这一轮抓到三个真 bug：门限估计会被「开头就大声」的第一帧顶到说话声之上（循环直接变聋）；
  说话期间关掉开关时**还在打开的麦克风会留下来继续录**；以及初始状态机没有重入保护会无限递归。
- 音色表实测：`POST /v1/get_voice` 返回 303 个系统音色，`/minimax-asr/voices` 原样下发并按语言分组；
  `/minimax-asr/speak` 的 `voice`/`speed` 覆盖用真实合成验过（`female-tianmei` → 21 KB `audio/mpeg`）。

**尚未端到端验证**：真人开口的那一次录音。Chrome 对新来源报 `microphone: prompt`，授权必须由使用者亲自完成。

## 说明

- 插件跑在 Harness 宿主进程里、自己读音频文件，所以 agent 的文件沙箱**不**约束这次读取：
  请指向宿主本来就能读到的文件。
- 它进不了模型/供应商选择器：MiniMax ASR 没有 chat-completions 接口，它是工具，不是对话模型。
- **长时间运行的实例在改动浏览器半之后需要重启一次**：客户端 bundle 的字节在模块注册表首次激活该包时被读取并定版本，
  单靠刷新页面仍会拿到旧字节。宿主半没有这个限制 —— 改设置或改工具，下一次调用就是新的。

## License

MIT
