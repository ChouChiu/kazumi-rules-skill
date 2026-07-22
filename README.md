# Kazumi Rules Skill

面向 Kazumi 2.2.x / 规则 API level 8 的规则开发 Skill，支持旧版 XPath 规则、JSON API 规则，以及搜索和选集阶段分别选择 XPath/API 的混合规则。

## 功能

- 使用 Chrome DevTools 分析 DOM，并从 Network Fetch/XHR 中寻找 JSON 接口
- 使用 curl 最小化复现 GET、POST JSON、POST form、headers、Cookie、重定向和编码行为
- 编写并验证 XPath 的 `searchList`、`searchName`、`searchResult`、`chapterRoads`、`chapterResult`
- 编写 API 8 的 `searchApiConfig`、`chapterApiConfig`、受限 JSONPath、nested/delimited 选集与播放页模板
- 支持 XPath/API、API/XPath 等混合模式
- 规范化规则 JSON，并生成经过往返验证的 `kazumi://` 导入链接
- 实际请求站点，探测搜索、选集、播放页、媒体地址或 iframe 线索
- 输出脱敏后的 curl 命令，不泄露 Cookie、Authorization、Token 等凭据

## 内置工具

```bash
node skills/kazumi-rules-skill/scripts/kazumi_rule_codec.ts /tmp/rule.json \
  --output /tmp/rule.normalized.json \
  --link-output /tmp/rule.link \
  --report

node skills/kazumi-rules-skill/scripts/kazumi_rule_probe.ts /tmp/rule.normalized.json \
  --keyword "葬送的芙莉莲" \
  --probe-iframe \
  --report-output /tmp/probe.json
```

- `kazumi_rule_codec.ts`：读取 JSON、Base64 或多种兼容形式的 `kazumi:` 链接，按活动模式校验 XPath/API 8 配置并导出规范链接。
- `kazumi_rule_probe.ts`：执行 XPath/API 混合搜索和选集，解析 nested/delimited 响应，构造播放页，并输出脱敏 curl 与解析诊断。

要求 Node.js 22.18 或更新版本。工具直接使用 Node 内置 TypeScript type stripping 运行，无 npm 依赖、无需构建。

## 推荐工作流

1. 在 Chrome DevTools 中执行搜索和选集操作，观察 DOM 或 Fetch/XHR 请求。
2. 用 curl 复现接口，逐步移除非必要 headers，确认最小请求。
3. 将请求映射为 XPath 或 API 8 规则，运行 codec 和 probe。
4. 在 Kazumi 内置规则测试页检查原始响应、匹配片段、线路和剧集地址。
5. 在 Kazumi 中完成实际播放测试；静态探测结果不能替代 WebView 嗅探。

## 安装

```bash
npx skills add ChouChiu/kazumi-rules-skill -y -g
```

## 相关资源

- [Kazumi 文档索引](https://kazumi.app/llms.txt)
- [XPath 规则开发](https://kazumi.app/docs/rules/develop-rules/)
- [API 规则开发](https://kazumi.app/docs/rules/develop-api-rules/)
- [视频嗅探架构](https://kazumi.app/docs/architecture/video-parser/)
- [Kazumi 源码](https://github.com/Predidit/Kazumi)
