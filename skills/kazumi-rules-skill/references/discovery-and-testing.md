# 抓包分析、接口复现与测试指引

## Chrome DevTools 抓包分析

1. **抓取搜索接口**：
   - 打开 Chrome / Edge 开发者工具（F12），切换至 **Network (网络)** 面板，勾选 **Fetch/XHR** 过滤项。
   - 在网页搜索框中输入真实番剧关键词（如“葬送的芙莉莲”），执行搜索。
   - 查看新增请求的 URL、Method、Status、Query Parameters / Request Body、Response Content-Type 与 JSON 结构。
2. **抓取选集与详情接口**：
   - 清空网络记录，点击进入搜索结果中的番剧详情页。
   - 抓取加载选集或分集列表的请求，确认该请求是如何使用搜索阶段返回的 ID / slug 作为参数的（对应 `@source`）。
3. **分析播放页构造与视频加载**：
   - 点击具体某一集进行播放，观察播放页 URL 的构造规律。
   - 若接口直接返回媒体流（m3u8/mp4）则直接提取；若返回加密/保护字符串或前端播放页，记录播放页参数（如 `slug`、`source`、`episode`）以配置 `episodePage`。

---

## curl 最小化复现

在将接口写入规则之前，先用 curl 复现并逐步剔除非必要的请求头，找出维持接口正常响应的**最小请求参数**。

### 1. GET 请求

```bash
curl --get 'https://example.com/api/search' \
  --data-urlencode 'q=紫罗兰永恒花园' \
  --data 'pageSize=20' \
  --compressed -i
```

### 2. POST JSON 请求

```bash
curl 'https://example.com/api/search' \
  -H 'Content-Type: application/json' \
  --data '{"keyword":"紫罗兰永恒花园"}' \
  --compressed -i
```

### 3. POST 表单请求

```bash
curl 'https://example.com/search.php' \
  --data-urlencode 'searchword=紫罗兰永恒花园' \
  --compressed -i
```

### 请求头精简与凭据脱敏原则

- **精简原则**：逐个移除浏览器默认带上的 Headers（如 `sec-ch-ua`、`accept-language`、`priority` 等）。仅在接口返回 403/拦截时，才针对性添加 `Referer`、`User-Agent` 或特定的自定义 Header。
- **凭据脱敏**：绝不要在公开规则、日志、示例中泄露真实的 Cookie、Authorization、Token、CSRF 凭证或 API Key。报告与示例中统一替换为 `<redacted>`。
- **短期状态判断**：如果接口必须依赖短效动态 Token、强滑块验证码或无法在 Kazumi 中复现的前端加密计算，说明该 API 不适合直接作为规则接口。应考虑使用 XPath 规则或寻找其他数据源。

---

## curl 到 Kazumi 规则配置的映射

| curl 参数 | 对应的 Kazumi 规则字段 |
|---|---|
| 请求目标地址 | `request.url` |
| `--get --data*` 查询参数 | `request.query`（JSON 键值对） |
| `-H` 自定义请求头 | `request.headers`（JSON 键值对） |
| `--data` JSON 格式内容 | `bodyType: "json"`, `body`（JSON 对象） |
| `--data` 表单格式内容 | `bodyType: "form"`, `body`（JSON 对象） |
| 搜索关键词占位 | 替换为 `@keyword` |
| 选集来源标识占位 | 替换为 `@source` |

---

## 多层分级测试流程

```text
1. curl 最小化复现 ➔ 2. Codec 格式校验 ➔ 3. Probe 静态探测 ➔ 4. Kazumi 内置测试 ➔ 5. 播放器真实播放
```

### 步骤 1：本地 Schema 与选择器校验

使用 `kazumi_rule_codec.ts` 检查语法错误、受限 JSONPath 越界或不支持的 XPath 函数：

```bash
node skills/kazumi-rules-skill/scripts/kazumi_rule_codec.ts /tmp/rule.json --report
```

### 步骤 2：全链路网络探测

使用 `kazumi_rule_probe.ts` 模拟 Kazumi 执行搜索、选集与播放页探测：

```bash
node skills/kazumi-rules-skill/scripts/kazumi_rule_probe.ts /tmp/rule.json \
  --keyword "葬送的芙莉莲" \
  --probe-iframe \
  --report-output /tmp/probe.json
```

- 检查搜索结果数量（`itemCount`）与提取到的 `selectedTitle` / `selectedSource`。
- 检查播放线路数量（`roadCount`）及剧集解析是否完整。
- 检查构造的播放页或提取到的媒体地址（`directMediaUrls` / `iframeUrls`）。

### 步骤 3：Kazumi 客户端真实测试

1. 在 Kazumi 中导入生成的 `kazumi://` 链接。
2. 进入规则详情页，点击右下角的**测试**按钮。
3. 搜索指定番剧，核对：
   - 匹配到的原始文本与片段。
   - 线路列表名称是否准确（如“线路A”“超清源”）。
   - 剧集列表排序是否正确，剧集数量与网页端是否一致。
4. 点击任意剧集进入播放页，测试视频能否正常起播与拖拽进度条。

> [!IMPORTANT]
> 静态 HTTP 探测工具（Probe）只能探测到页面内直接输出的直链或 iframe 链接，无法执行前端复杂的 JavaScript 播放器逻辑。**Kazumi 客户端内的播放测试是唯一具备决定性的验证标准**。
