# niconico 弹幕翻译 (AI Danmaku Translator)

一个 Tampermonkey 油猴脚本：用 MiniMax 大模型把 **niconico 弹幕**实时翻译成中文，直接注入播放器 Canvas 渲染层，跟随原弹幕的滚动、字号与描边，无需额外界面。

> English: A Tampermonkey userscript that translates Niconico danmaku (bullet comments) into Chinese in real time using the MiniMax LLM, injected directly into the player's canvas rendering layer.

本仓库包含两个脚本：

| 脚本 | 作用 | 适用范围 | 一键安装 |
| --- | --- | --- | --- |
| [`niconico-danmaku-translator.user.js`](niconico-danmaku-translator.user.js) | 翻译 niconico **弹幕** | 仅 niconico | **[安装](https://github.com/YiShan-X/niconico-danmaku-translator/raw/main/niconico-danmaku-translator.user.js)** |
| [`web-subtitle-translator.user.js`](web-subtitle-translator.user.js) | 抓取标签页音频，实时生成**语音字幕**并翻译 | **任意网站** | **[安装](https://github.com/YiShan-X/niconico-danmaku-translator/raw/main/web-subtitle-translator.user.js)** |

> 直接安装前提：先装好 [Tampermonkey](https://www.tampermonkey.net/)。点「安装」会打开 `.user.js` 的 **Raw** 地址，油猴会自动弹出安装页。


## 特性

- 实时翻译 niconico 弹幕，Canvas 层替换，不遮挡视频
- 批量翻译 + 并发请求 + 本地缓存（跨视频复用，重复弹幕不重复翻译）
- 按播放进度滚动预翻译，尽量在弹幕出现前备好译文
- 可配置模型 / 目标语言 / API Key
- 译文过长时自动缩小字号，避免被离屏画布裁切
- 关闭模型思考模式，20 条弹幕约 3 秒完成

## 环境要求

- 浏览器 + [Tampermonkey](https://www.tampermonkey.net/)（或 Violentmonkey）
- [MiniMax](https://platform.minimaxi.com/) API Key（首次使用在设置面板填写）

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 浏览器扩展。
2. **一键安装**：[niconico-danmaku-translator.user.js](https://github.com/YiShan-X/niconico-danmaku-translator/raw/main/niconico-danmaku-translator.user.js)（打开后点「安装」即可）。
3. 打开任意 niconico 视频页，例如 `https://www.video.nicovideo.jp/watch/sm...`。

## 使用

- 视频右上角的胶囊按钮 **「弹幕翻译：开 / 关」**：一键开关翻译。
- 旁边的 **⚙** 齿轮按钮：打开设置面板。
- 面板内可填写 **API Key**、目标语言、模型，并提供「测试连接 / 清空缓存」。
- 首次使用会自动弹出面板提示填写 API Key（未填写时不会发起请求）。
- 也可通过 Tampermonkey 菜单命令切换。

## 工作原理

1. 拦截 `POST public.nvcomment.nicovideo.jp/v1/threads`，拿到全部弹幕数据（`body` + `vposMs`）。
2. 根据 `video.currentTime` 滚动预取「当前时刻前 15 秒内」的弹幕，批量发给 MiniMax 翻译（带并发、重试、缓存）。
3. Hook `CanvasRenderingContext2D.prototype.fillText / strokeText`，通过字体签名识别弹幕绘制，把原文替换为缓存中的译文。
4. niconico 会为每条弹幕预渲染到独立的离屏 canvas 再合成，因此译文必须在首次渲染前准备好——这正是采用「滚动预翻译」的原因。
5. 关闭模型思考模式（`thinking: {type:"disabled"}`），把 20 条约 53s 的延迟降到约 3s。

## 配置项

在设置面板修改，保存于 Tampermonkey 存储：

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| API Key | 空（必填） | MiniMax API Key |
| 模型 | `MiniMax-M3` | 任意 OpenAI 兼容模型 ID |
| 目标语言 | 简体中文 | 译文语言 |
| 预翻译窗口 | 15s | 提前翻译的时长 |
| 批大小 / 并发 | 25 / 4 | 每次请求条数与并发数 |

## 已知限制

- 无假名的纯汉字弹幕按「无需翻译」跳过。
- 开播后最初几秒的弹幕可能来不及翻译，之后恢复正常。
- 少数批量翻译结果偶有错位（已加入返回长度校验，不符则重试）。
- 直播实时弹幕首帧可能仍显示日文。

## License

[MIT](LICENSE)

---

# 网页实时字幕翻译 (Web Subtitle Translator)

一个**通用**的 Tampermonkey 油猴脚本：捕获当前**标签页的音频**，用阿里云百炼 **Qwen (`qwen3-asr-flash`)** 识别语音，再用 **MiniMax** 翻译成中文，在**任意网站**的播放器底部实时叠加字幕。与具体网站无关，只要有声音即可。

> English: A universal Tampermonkey userscript that captures the current tab's audio, transcribes speech with Qwen (`qwen3-asr-flash`) and translates it with MiniMax, overlaying subtitles on **any** website.

## 特性

- **通用**：`@match` 覆盖所有 http/https 站点，不依赖任何网站结构
- 只做**云端识别**，无需下载本地模型，CPU / 内存几乎零占用
- 翻译走 MiniMax，跨语言可配置（默认日译中）
- 批量请求 + 静音跳过，字幕**保留到下一句出现**才替换
- 全中文设置面板，可配置识别 / 翻译 Key、模型、语言、分片时长、字号

## 环境要求

- 浏览器 + [Tampermonkey](https://www.tampermonkey.net/)（或 Violentmonkey）
- [阿里云百炼](https://bailian.console.aliyun.com/) API Key（用于 Qwen 语音识别）
- [MiniMax](https://platform.minimaxi.com/) API Key（用于翻译）

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 浏览器扩展。
2. **一键安装**：[web-subtitle-translator.user.js](https://github.com/YiShan-X/niconico-danmaku-translator/raw/main/web-subtitle-translator.user.js)（打开后点「安装」即可）。
3. 打开任意**正在播放声音**的网页。

## 使用

1. 点右上角 **「字幕：关」** → 在浏览器弹窗里选择**本标签页 / 整个屏幕**，并勾选 **「同时共享音频」**。
2. 视频开始播放后，字幕会自动出现在**底部居中**。
3. 点 **⚙** 齿轮打开设置面板，填写 **Qwen API Key**（识别）与 **MiniMax API Key**（翻译）。

## 工作原理

1. `getDisplayMedia({video,audio})` 捕获标签页音频，停止视频轨，仅保留音频。
2. `AudioContext(16kHz)` + `ScriptProcessor` 采集 PCM，按 `分片秒数` 切段，静音自动跳过。
3. 每段编码为 16kHz 单声道 WAV → Base64 → 通过 `GM_xmlhttpRequest` 调用 Qwen **OpenAI 兼容**接口（`/compatible-mode/v1/chat/completions`，`input_audio`），绕过 CORS。
4. 识别文本交给 MiniMax 翻译，结果显示在页面底部的字幕层；**保留到下一句替换**。

## 配置项

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| Qwen API Key | 空（必填） | 阿里云百炼 Key，用于语音识别 |
| Qwen 识别地址 | `https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions` | OpenAI 兼容端点 |
| Qwen 模型 | `qwen3-asr-flash` | 语音识别模型 |
| Qwen 语言 | `ja` | 识别语言（ja/zh/en…） |
| MiniMax API Key | 空（翻译必填） | 用于翻译 |
| MiniMax 模型 | `MiniMax-M3` | 翻译模型（实测 M3 最快且支持关闭思考；highspeed 系列反而更慢） |
| 目标语言 | 简体中文 | 译文语言 |
| 分片秒数 | 8 | 每段音频长度，越小越实时、越大越省请求 |
| 显示原文 | 开 | 译文下方显示识别原文 |

## 已知限制

- 必须**手动授权**共享音频（浏览器安全限制，无法静默捕获）。
- 纯 http 页面无法使用（`getDisplayMedia` 需要 https 安全上下文）。
- 抓取的是**整个标签页音频**，BGM / 音效也会被识别，偶有误识别。
- 语音识别与翻译均需联网，并产生对应 API 费用。

