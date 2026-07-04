# Kazumi Rules Skill

一个用于 [Kazumi](https://github.com/Predidit/Kazumi) 的 LLM 技能，可通过 [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) 浏览器自动化来编写和调试 XPath 规则。

## 功能

- 自动导航目标动漫网站并执行搜索
- 通过 `evaluate_script` 提取 XPath 表达式（`searchList`、`searchName`、`searchResult`、`chapterRoads`、`chapterResult`）
- 组装 JSON 规则（api 级别 1-7）
- Base64 编码并导出 `kazumi://` 导入链接
- 调试 XPath 匹配失败、播放异常等问题

## 使用场景

- 为动漫网站编写 Kazumi 规则
- 提取视频站点的 XPath
- 调试规则不匹配问题
- 生成 kazumi:// 导入链接

## 前置条件

需要配置 chrome-devtools MCP 服务器。在 MCP 配置中添加：

```json
"chrome-devtools": {
  "type": "local",
  "command": ["npx", "-y", "chrome-devtools-mcp@latest"]
}
```

## 安装

```bash
npx skills add ChouChiu/kazumi-rules-skill -y -g
```

## 工作流程

1. **导航探索** — 访问目标网站，执行测试搜索
2. **确定 searchURL** — 提取搜索接口地址（GET / POST）
3. **提取 searchList** — 定位搜索结果容器
4. **提取 searchName** — 提取每个结果的标题
5. **提取 searchResult** — 确定详情页/播放页链接
6. **提取 chapterRoads / chapterResult** — 提取章节列表
7. **组装验证** — 组合完整 JSON 规则
8. **导出链接** — Base64 编码，生成 `kazumi://` 导入链接
9. **用户测试迭代** — 根据反馈调试修复

## 相关资源

- [Kazumi 规则开发指南](https://kazumi.app/docs/rules/develop-rules)
- [Kazumi 规则开发示例](https://kazumi.app/docs/rules/develop-rules-example)
- [KazumiRules 社区规则仓库](https://github.com/Predidit/KazumiRules)
- [Kazumi App](https://github.com/Predidit/Kazumi)
- [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp)
