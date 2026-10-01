# Kazumi Rules Skill

面向 [Kazumi](https://kazumi.app/) 的规则开发 Skill。支持 XPath 规则、JSON API 规则，以及搜索与选集阶段独立配置的混合模式规则。

## 功能特性

- **DevTools 抓包与结构分析**：指导在 Elements 面板提取 DOM 结构，在 Network (Fetch/XHR) 面板分析 JSON 接口。
- **curl 最小化复现**：快速验证 GET / POST JSON / POST Form 请求，精简请求头并确保凭据脱敏。
- **XPath 规则校验**：严格校验 `searchURL`、`searchList`、`searchName`、`searchResult`、`chapterRoads`、`chapterResult` 及受限语法子集。
- **API 规则校验**：校验 `searchApiConfig`、`chapterApiConfig`、受限 JSONPath、嵌套/分隔符选集格式及 `episodePage` 模板。
- **混合模式支持**：支持 XPath 搜索 + API 选集、API 搜索 + XPath 选集等组合。
- **规范化与编解码**：规范化规则 JSON，支持往返校验并导出标准的 `kazumi://` 导入链接。
- **端到端网络探测**：模拟搜索、选集与播放页解析，输出脱敏 curl 命令与诊断日志。

## 内置工具

无需构建、无需安装 npm 依赖，直接使用 Node.js 内置 TypeScript 支持执行：

```bash
# 1. 规则校验、规范化与生成 kazumi:// 导入链接
node skills/kazumi-rules-skill/scripts/kazumi_rule_codec.ts /tmp/rule.json \
  --output /tmp/rule.normalized.json \
  --link-output /tmp/rule.link \
  --report

# 2. 实际请求站点执行搜索、选集与播放页探测
node skills/kazumi-rules-skill/scripts/kazumi_rule_probe.ts /tmp/rule.normalized.json \
  --keyword "葬送的芙莉莲" \
  --probe-iframe \
  --report-output /tmp/probe.json
```

- `kazumi_rule_codec.ts`：读取 JSON、Base64 或多种兼容格式的 `kazumi://` 链接，执行语法规则检查与规范化导出。
- `kazumi_rule_probe.ts`：执行完整搜索、选集、嵌套/分隔符解析与播放页构造探测，输出脱敏后的 curl 命令与结构诊断。

## 推荐工作流

1. **抓包分析**：在浏览器 DevTools 中执行搜索和选集操作，查看 DOM 或 Fetch/XHR 接口。
2. **最小化复现**：使用 curl 复现请求，逐步剔除非必要 headers，确认最小有效请求。
3. **编写规则**：将请求映射为 XPath 或 API 规则 JSON。
4. **校验与探测**：运行 `kazumi_rule_codec.ts` 和 `kazumi_rule_probe.ts` 检查合规性与提取结果。
5. **客户端测试**：在 Kazumi 内置规则测试页检查原始响应、匹配片段、线路和剧集。
6. **播放验证**：在 Kazumi 中进行实际起播测试（静态探测不能替代 WebView 嗅探）。

## 安装

```bash
npx skills add ChouChiu/kazumi-rules-skill -y -g
```

## 相关资源

- [Kazumi 官网](https://kazumi.app/)
- [Kazumi XPath 规则开发](https://kazumi.app/docs/rules/develop-rules)
- [Kazumi XPath 规则示例](https://kazumi.app/docs/rules/develop-rules-example)
- [Kazumi API 规则开发](https://kazumi.app/docs/rules/develop-api-rules)
- [Kazumi 视频嗅探原理](https://kazumi.app/docs/architecture/video-parser)
- [Kazumi 源码仓库](https://github.com/Predidit/Kazumi)
- [Kazumi 社区规则仓库](https://github.com/Predidit/KazumiRules)
