# dsh-minimax-asr

把 MiniMax 语音识别（`asr-1.0`）接成 **DeepSeek Harness 全局插件**：一个给模型用的
`transcribe_audio` 工具、一张设置卡片，以及输入框里的语音输入按钮。

<img width="1752" height="956" alt="34256464645645" src="https://github.com/user-attachments/assets/8dfdb0ba-7788-468c-b7bd-53e70c659c50" />


中文 | [English](README.en.md)

## 它提供什么

| 面 | 内容 |
| --- | --- |
| 工具 | `transcribe_audio(path, language?, response_format?, timestamp_level?)` |
| 接口 | `POST <baseURL>/v1/speech_to_text`（multipart，默认 `model=asr-1.0`） |
| 凭据 | 默认引用 `MINIMAX_API_KEY`，每次请求经 credentials seam 重新解析（可热轮换） |
| 设置 | 命名空间 `minimax-asr`：`apiKeyEnv`、`baseURL`、`model`、`responseFormat`、`language`、`timestampLevel`、`maxFileMB`、`timeoutMs` |
| 卡片 | 由 `client/client.js` 渲染在「设置 → 插件」里 |
| 语音输入 | 输入框工具行的麦克风按钮：录音 → 转写 → 追加进草稿 |

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

## 本地路由

两个路由挂在同一个受护栏的前缀下（loopback `Host`、无跨站标记、`Origin` 匹配；
这是防 DNS rebinding / 跨站的姿势，不是身份认证）：

| 路由 | 用途 |
| --- | --- |
| `POST /minimax-asr/transcribe` | 收一段录音（`audio/wav` 正文，可选 `?format=`、`?level=`、`?language=`、`?name=`），返回转写 |
| `GET /minimax-asr/diagnostics` | 浏览器半自报的接线状态：`applied`、`card-registered`、`mic-registered`、`mic-rendered`（有上限、只在内存、不含机密） |
| `POST /minimax-asr/diagnostics` | 浏览器半上报这些事实的入口 |

想确认"浏览器半加载了没有、控件挂上没有"，`GET /minimax-asr/diagnostics` 是最快的答案。

## 不依赖 Harness 的测试

```sh
MINIMAX_API_KEY=... node tests/smoke.mjs <音频文件> [response_format] [timestamp_level]
MINIMAX_API_KEY=... node tests/route-smoke.mjs <音频文件>
node tests/client-smoke.mjs
node tests/installed-check.mjs <profile 目录>
```

- `tests/smoke.mjs`：加载 `lib/index.js`，用桩上下文执行 `apply`，再对真实接口跑一次工具调用。
- `tests/route-smoke.mjs`：用合成的 node 请求驱动路由 —— 覆盖全部护栏与体积拒绝、diagnostics 通道，
  以及一次真实转写。
- `tests/client-smoke.mjs`：按浏览器的方式加载 `client/client.js`（经典脚本调用
  `window.__ModuleLoader__.load`），在桩 React / 模块表下断言卡片渲染与它写出的 path ops，
  并把整条麦克风流水线跑通（只伪造编解码器与网络），断言上传 WAV 的文件头、采样率与采样数。
- `tests/installed-check.mjs`：从 profile 解析**已安装**的包，断言宿主客户端扫描器需要的一切
  （`dsh.client.platform`、`./client` 字节、bundle id、每个声明的 inject、宿主半的导出形状），
  外加"只有一个激活行"这条不变量。

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

**尚未端到端验证**：真人开口的那一次录音。Chrome 对新来源报 `microphone: prompt`，授权必须由使用者亲自完成。

## 说明

- 插件跑在 Harness 宿主进程里、自己读音频文件，所以 agent 的文件沙箱**不**约束这次读取：
  请指向宿主本来就能读到的文件。
- 它进不了模型/供应商选择器：MiniMax ASR 没有 chat-completions 接口，它是工具，不是对话模型。
- **长时间运行的实例在改动浏览器半之后需要重启一次**：客户端 bundle 的字节在模块注册表首次激活该包时被读取并定版本，
  单靠刷新页面仍会拿到旧字节。宿主半没有这个限制 —— 改设置或改工具，下一次调用就是新的。

## License

MIT
