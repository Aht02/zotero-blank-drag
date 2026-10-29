# Zotero Blank Drag · 空白拖拽

[![Latest release](https://img.shields.io/github/v/release/Aht02/zotero-blank-drag?label=release)](https://github.com/Aht02/zotero-blank-drag/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

适配 Zotero 10 的 PDF 阅读器。默认选择工具下，在页面空白、图片区域或页面之间的灰色区域按住鼠标左键拖动，页面随鼠标平移。放大后也可以横向拖动。

## 安装

1. 打开 [Releases](https://github.com/Aht02/zotero-blank-drag/releases/latest)，下载最新的 `zotero-blank-drag-1.0.0.xpi`。
2. 在 Zotero 中打开「工具 → 插件」，点右上角的齿轮，选择「从文件安装插件」，选中刚下载的文件。
3. 如果已打开的 PDF 没有立即生效，重新打开该 PDF。

**更新请手动安装**：下载新版 XPI 覆盖安装即可，Zotero 会替换旧版并保留设置。本插件不推送自动更新——Zotero 10 要求插件清单必须带 HTTPS 更新地址（缺失会拒绝安装），所以仓库里仍有 `updates.json`，但其中只列当前版本，不会提示升级。

## 使用

保持阅读器的默认文字选择工具，在非文字区域按住左键拖动即可；从第 1 像素开始跟随，没有启动距离门槛或时间防抖。

未按鼠标时，可拖动的非文字区域显示箭头；按下左键立即显示抓手，按住不动、轻微移动和拖动过程中均保持抓手，松开后恢复箭头。空白拖动直接使用 Zotero/PDF.js 自带的 GrabToPan：插件不自行捕获指针或在 pointermove 中写滚动位置，也不切换工具栏的选择工具。在文字上拖动仍然选字；链接、批注、批注调整手柄、输入框、滚动条和右键菜单交给 Zotero 原有逻辑处理。高亮、下划线、区域选择、便笺、文本、绘图、橡皮和全局原生手形工具启用时，插件不接管。Shift、Ctrl、Alt 或 Command 不再临时跳过空白拖拽；从文字区域开始的修饰键操作仍交给 Zotero。触摸和笔输入不接管。

支持 PDF 标签页、独立阅读窗口和双分屏。禁用或卸载插件会清理监听器，无需修改 PDF 或文献库。插件运行代码没有联网、遥测或额外依赖。

### 滚动条与快速滚轮

滚动条滑块、轨道、箭头及横向滚动条不启动空白拖拽；拖动滑块和点击滑块上方/下方均使用 Zotero 的原生行为。包含不占页面宽度的悬浮滚动条，不会为避让滚动条而额外占用正文边缘。

鼠标在 PDF **竖向滚动条一列**时，普通滚轮每次向对应方向滚动约半个可视窗口（不是半张 PDF 页）；移回正文则恢复原生速度。参照 [SumatraPDF 的 FastScrollOverScrollbar 实现](https://github.com/sumatrapdfreader/sumatrapdf/blob/9edfa4449c2720bbba1fe4e9eccdabc3ec5d34c1/src/Canvas.cpp#L3710)。这不是整套 SumatraPDF 阅读模式的移植。

Ctrl/Command、Shift、Alt 修饰的滚轮、横向输入、按住鼠标时的滚轮以及系统按页滚动输入不接管，保留缩放等原有行为。像素模式输入按幅度换算（100 CSS 像素对应半屏，每次最多半屏），避免触摸板微动也跳半屏。该规则不改变修饰键空白拖拽功能。

## 兼容性

- Zotero 10.0.x（在 **10.0.6** 上实测）。
- 按本机 Zotero 10.0.6 的实际阅读器源码适配，使用其字符坐标及批注命中检测。
- 当前作用于普通 PDF 阅读视图，不接管 EPUB、网页快照或重排阅读模式。
- 文字数据尚未加载时不接管该页，避免误抢选字。没有 OCR 文字层的扫描页会被视为图片区域。
- 图中若有可选文字或 OCR 文字，该位置仍优先选字。字符周围留出约 2 个屏幕像素的选字余量。
- 使用 Zotero 内部阅读器接口；后续 10.x 如改变这些接口，可能需要更新插件。

## 与 Zotero Smart Hand 的关系

作者另有一个 [Zotero Smart Hand](https://github.com/Aht02/zotero-smart-hand)（手型工具下的智能手型）。两者都会接管 PDF 的拖动与选字，**功能部分重叠，建议只启用其中一个**：

- 本插件作用于阅读器**默认的文字选择工具**。
- Smart Hand 作用于阅读器**原生手型工具**。

## 从源码构建

无需安装依赖：

```powershell
node --test tests/*.test.cjs
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build.ps1
```

安装包位于 `dist/`，只包含 `manifest.json`、`bootstrap.js` 和 `content/blank-drag.js`。

## 测试

验证使用 Windows 上 Zotero 10.0.6 的隔离配置：安装最终 XPI、注入真实阅读器鼠标事件、检查光标样式。



## 版本

- **1.0.0** —— 首个公开发布版（开发期编号 1.0.7）。改用阅读器实际的原生 GrabToPan 实例；保留先于选字的空白判断，以及滚动条避让、半屏滚轮、按下即抓手和悬停防闪烁。无法取得原生接口时不接管，不退回自制拖动。

## 许可证

[MIT](LICENSE)
