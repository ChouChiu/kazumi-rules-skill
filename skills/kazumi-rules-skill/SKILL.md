---
name: kazumi-rules-skill
description: "Kazumi 2.2.x / 规则 API 8 与旧版 XPath 规则的创建、校验、探测、编解码与调试工具。用于开发 Kazumi XPath 规则、JSON API 规则、混合模式规则、JSONPath 提取、反爬虫配置、播放页解析及 kazumi:// 导入链接生成。配合 Chrome DevTools 抓包与 DOM 分析、curl 最小化复现、内置 Node 工具验证与 Kazumi 最终播放测试。"
---

# Kazumi 规则开发指南

开发 Kazumi 番剧规则。单条规则为一个独立的 JSON 对象（禁止用数组包裹）。

适配 Kazumi 2.2.x 与规则 API level 8，兼容旧版 API 1-7 XPath 规则。`useWebview` 与 `useNativePlayer` 为保留兼容字段。

## 模块参考文档

- XPath 搜索与选集规则：[references/xpath-rules.md](references/xpath-rules.md)
- API 搜索与选集规则：[references/api-rules.md](references/api-rules.md)
- 抓包分析、curl 复现、脱敏与测试流程：[references/discovery-and-testing.md](references/discovery-and-testing.md)

---

## 规则模式选型

搜索（`searchMode`）与选集（`chapterMode`）相互独立，可分别选择 `xpath` 或 `api`：

| 搜索阶段 (`searchMode`) | 选集阶段 (`chapterMode`) | 适用场景 |
|---|---|---|
| `xpath` | `xpath` | 服务端渲染完整 HTML 的传统站点 |
| `api` | `api` | 前端通过 JSON API 加载搜索与详情/选集的站点 |
| `api` | `xpath` | 搜索接口返回 JSON，从中提取的详情页 URL 为服务端渲染 HTML |
| `xpath` | `api` | 搜索结果为 HTML，提取的详情链接/ID 可直接作为参数调用选集 JSON API |

> [!NOTE]
> - 缺省模式字段时，Kazumi 默认按 `xpath` 处理。
> - 只要搜索或选集任一阶段启用了 `api` 模式，规则根属性 `api` 必须设为 `"8"`。
> - 不要仅因 SPA 页面无服务端 HTML 就放弃：先检查 Network (Fetch/XHR)，优先使用稳定的 JSON 接口。

---

## 标准开发流程

1. **抓包分析**：在浏览器 DevTools 中执行一次搜索与进入选集操作。检查 HTML DOM 结构（Elements）或网络接口（Network Fetch/XHR）。
2. **确定阶段模式**：优先选用无需复杂浏览器状态即可稳定复现的 JSON API；若无可用 API 则使用 XPath。
3. **curl 最小化复现**：用 curl 复现请求，逐个剔除非必要请求头，确认能够返回目标数据的最小请求（请求头、Query、Body、Referer、Cookie）。
4. **编写规则 JSON**：
   - 提取参数替换为对应占位变量（搜索关键词用 `@keyword`，选集来源用 `@source`）。
   - 在 API 模式下，旧版 XPath 字段保留为空字符串 `""`。
   - 配置对应的 `searchApiConfig` 或 `chapterApiConfig`。
5. **本地校验与探测**：
   - 运行 `kazumi_rule_codec.ts` 校验字段合法性与受限表达式。
   - 运行 `kazumi_rule_probe.ts` 发起实际网络探测，检查搜索提取、线路及剧集构造。
6. **导出规范链接**：生成标准 `kazumi://<base64>` 导入链接。
7. **客户端最终验证**：在 Kazumi 客户端规则测试界面验证各线路与集数，并在播放器中测试实际播放（静态探测无法替代原生 WebView 视频嗅探）。

---

## 内置工具说明

要求 Node.js 22.18+，直接使用 Node 内置 TypeScript type stripping 执行，无需安装 npm 依赖。

### 1. 规则校验、规范化与编解码 (`kazumi_rule_codec.ts`)

```bash
# 校验并生成规范化 JSON 与导入链接
node skills/kazumi-rules-skill/scripts/kazumi_rule_codec.ts /tmp/rule.json \
  --output /tmp/rule.normalized.json \
  --link-output /tmp/rule.link \
  --report
```

- 支持输入：JSON 文件路径、原始 Base64、`kazumi://` 链接、标准输入 `-`。
- 自动校验 XPath 受限子集、JSONPath 语法合规性、API 请求配置及模板变量合法性。
- 自动校验 Base64 往返一致性（Round-trip check）。

> [!IMPORTANT]
> 包含 XPath 单双引号的 JSON（如 `[@class='result']`），请先写入文件再传给工具，避免 Shell 引号转义导致选择器损坏。

### 2. 接口与选集实测探测 (`kazumi_rule_probe.ts`)

```bash
# 执行完整搜索、选集与播放页静态探测
node skills/kazumi-rules-skill/scripts/kazumi_rule_probe.ts /tmp/rule.normalized.json \
  --keyword "葬送的芙莉莲" \
  --probe-iframe \
  --report-output /tmp/probe.json
```

- 模拟 Kazumi 执行当前活动模式的搜索和选集流程（支持 XPath/API 任意混合）。
- 验证嵌套（Nested）和分隔符（Delimited）选集解析与 `episodePage` 构造。
- 输出脱敏后的 curl 命令（自动将 Cookie、Token、Authorization 替换为 `<redacted>`）。

---

## 核心规范速查

### XPath 规则要求

- 字段：`searchURL`、`searchList`、`searchName`、`searchResult`、`chapterRoads`、`chapterResult`。
- `searchList` 和 `chapterRoads` 必须定位到**每个重复的条目/线路节点**，不能仅停留在外部公共容器。
- `searchName` 和 `searchResult` 为相对于单个搜索结果节点的路径；`chapterResult` 为相对于单个线路节点的路径。
- 所有非 URL 选择器必须以 `//` 开头。
- **仅支持 Kazumi 兼容的 XPath 子集**：
  - 属性匹配：`[@attr='val']`、`[@attr*='val']`（包含）、`[@attr^='val']`（前缀）、`[@attr$='val']`（后缀）、`[@attr~='val']`（单词列表）。
  - 序号索引：`[1]`、`[2]`。
  - **禁止使用**：`contains()`、`starts-with()`、`text()`、`normalize-space()`、`and`、`or`、`|`、`::`、`..`。
- POST 表单搜索：设置 `"usePost": true`，`searchURL` 填写带有查询参数的完整地址（如 `https://example.com/search.php?wd=@keyword`），Kazumi 会自动剥离查询参数并以 Form 表单提交。
- 反爬配置：仅适用于 XPath 搜索阶段，`antiCrawlerConfig` 支持图片验证码（1）、自动点击（2）、自定义 JS 脚本（3）。

### API 规则要求 (API Level 8)

- 请求配置：支持 `GET` 和 `POST`，Body 类型支持 `none`、`json`、`form`。
- **受限 JSONPath**：
  - 必须以 `$` 开头。
  - 支持字段：`$.data.videos`、`$['field-name']`、`$.data.videos[*]`（通配符）、`$.data.videos[0]`（下标）。
  - **禁止使用**：递归 `$..`、过滤 `[?()]`、切片 `[0:2]`、函数调用。
- **选集格式**：
  - `nested`（嵌套 JSON）：通过 `roadsPath`、`roadNamePath`、`episodesPath`、`episodeNamePath`、`episodeUrlPath` 分层解析。
  - `delimited`（分隔符字符串）：通过 `roadNamesPath`、`roadEpisodesPath`、`roadSeparator`（默认 `$$$`）、`episodeSeparator`（默认 `#`）、`fieldSeparator`（默认 `$`）解析。
- **播放页构造模板 (`episodePage`)**：
  - 当 API 未直接返回媒体地址或网页链接时使用。
  - 支持变量：`@source`、`@episodeUrl`、`@roadIndex`（从 0 开始）、`@roadNumber`（从 1 开始）、`@episodeIndex`（从 0 开始）、`@episodeNumber`（从 1 开始），以及 `variables` 中通过 JSONPath 提取的自定义响应变量（如 `@slug`）。

---

## 交付前检查清单 (Checklist)

交付规则给用户前，确认以下各项均已满足：

- [ ] 规则为**单一 JSON 对象**，包含 `name`、`version`、`baseURL`、`api` 等必要字段。
- [ ] 启用了 API 模式时，根字段 `api` 为 `"8"`。
- [ ] 激活的 XPath 字段均以 `//` 开头，且只使用 Kazumi 支持的选择器语法。
- [ ] 激活的 API 字段均使用合法的受限 JSONPath 表达式。
- [ ] API 选集配置中提供了有效的 `episodeUrlPath` 或非空的 `episodePage.url`。
- [ ] 模板变量名正确（`@keyword`、`@source`、`@roadIndex`/`@roadNumber`、`@episodeIndex`/`@episodeNumber`）。
- [ ] `kazumi_rule_codec.ts` 校验通过，Base64 导入链接往返一致。
- [ ] `kazumi_rule_probe.ts` 搜索与选集探测成功。
- [ ] 交付内容包含：格式化后的规则 JSON、`kazumi://` 导入链接、以及提示用户在 Kazumi 中进行播放测试的说明。

---

## 官方资源

- [Kazumi 文档首页](https://kazumi.app/)
- [XPath 规则开发](https://kazumi.app/docs/rules/develop-rules)
- [XPath 规则示例](https://kazumi.app/docs/rules/develop-rules-example)
- [API 规则开发](https://kazumi.app/docs/rules/develop-api-rules)
- [视频嗅探原理](https://kazumi.app/docs/architecture/video-parser)
- [Kazumi 开源仓库](https://github.com/Predidit/Kazumi)
- [KazumiRules 社区规则仓库](https://github.com/Predidit/KazumiRules)
