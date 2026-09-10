# niconico 弹幕翻译 (AI Danmaku Translator)

一个 Tampermonkey 油猴脚本：用 MiniMax 大模型把 **niconico 弹幕**实时翻译成中文，直接注入播放器 Canvas 渲染层，跟随原弹幕的滚动、字号与描边，无需额外界面。

> English: A Tampermonkey userscript that translates Niconico danmaku (bullet comments) into Chinese in real time using the MiniMax LLM, injected directly into the player's canvas rendering layer.

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

1. 安装 Tampermonkey 浏览器扩展。
2. 打开仓库中的 `niconico-danmaku-translator.user.js`，点击 **Raw**，Tampermonkey 会弹出安装页；或在 Tampermonkey 中新建脚本并粘贴文件内容。
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
