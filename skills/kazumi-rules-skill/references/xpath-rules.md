# Kazumi XPath 规则开发

## 字段定义

当 `searchMode` 或 `chapterMode` 为 `xpath` 时，使用以下字段：

| 字段 | 说明 | 示例 |
|---|---|---|
| `searchURL` | 搜索请求地址模板，包含 `@keyword` 占位符 | `https://example.com/search.php?wd=@keyword` |
| `searchList` | 选中每一个搜索结果条目节点 | `//ul[@class='search-list']//li` |
| `searchName` | 相对于单个搜索条目，提取作品名称 | `//h4/a` |
| `searchResult` | 相对于单个搜索条目，提取进入详情页或播放页的链接 | `//h4/a` 或 `//p/a[@class='detail']` |
| `chapterRoads` | 选中目标页面中的每一个播放线路容器 | `//div[@class='play-source']//div[@class='road']` |
| `chapterResult` | 相对于单个线路容器，提取该线路下所有剧集的链接节点 | `//ul/li/a` |

---

## 语法支持子集

Kazumi 内部使用轻量级 XPath 解析器，与标准浏览器 `document.evaluate` 存在语法差异。

### 支持的语法

```text
//div                                          # 标签选择
//ul//li                                       # 后代选择
//a                                            # 链接选择
//div[@class='item']                           # 精确属性匹配
//div[@class~='active']                        # 单词列表匹配
//a[@href^='/vod/']                            # 属性前缀匹配
//img[@src$='.webp']                           # 属性后缀匹配
//div[@class*='search']                        # 属性包含匹配（替代 contains）
//li[1]                                        # 序号索引（从 1 开始）
```

### 禁止使用的语法

- **禁用 XPath 函数**：`contains()`、`starts-with()`、`normalize-space()`、`substring()`、`string()`、`last()`、`text()` 等。
- **禁用逻辑运算符**：`and`、`or`。
- **禁用轴与联合**：`|`（联合选择）、`::`（轴选择器如 `ancestor::`、`following-sibling::`）。
- **禁用父级回溯**：`../`。

> [!TIP]
> 常见替换方案：
> - 包含文本/类名：`contains(@class, 'box')` ➔ `[@class*='box']`
> - 前缀匹配：`starts-with(@href, '/play')` ➔ `[@href^='/play']`

---

## DOM 路径提取方法

1. **确定条目节点 (`searchList`)**：
   - 找到搜索列表容器，展开查看重复的条目元素（如多个 `<li>` 或 `<div>`）。
   - 选择器必须定位到**具体的每个条目**，例如 `//ul[@id='list']//li`，而不是仅定位到 `<ul>`。
2. **提取条目内相对路径 (`searchName`, `searchResult`)**：
   - 必须以单个条目为起点，删除公共路径前缀。
   - 若作品标题本身即为可点击的详情链接，`searchResult` 可与 `searchName` 指向同一元素。
3. **确定进入的页面类型**：
   - 若 `searchResult` 指向番剧详情页，`chapterRoads` 与 `chapterResult` 需根据详情页 HTML 编写。
   - 若 `searchResult` 直接指向播放页，选集选择器需根据播放页 HTML 编写。
4. **定位播放线路 (`chapterRoads`)**：
   - 定位到包含一组剧集的独立线路容器。有几条线路，该选择器应命中几个节点。
5. **提取剧集链接 (`chapterResult`)**：
   - 定位到该线路下的所有剧集链接。
   - 必须移除具体集数的数字索引限制（例如将 `//li[12]/a` 改为 `//li/a`）。

---

## 浏览器控制台相对路径验证脚本

在 Chrome DevTools Console 中运行以下代码，模拟验证相对选择器：

```javascript
(() => {
  const parentPath = "//li[@class='item']";
  const childPath = "//h3/a";
  const relative = childPath.startsWith("//") ? `.${childPath}` : childPath;

  const parents = document.evaluate(
    parentPath,
    document,
    null,
    XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
    null,
  );
  if (!parents.snapshotLength) {
    return { error: "Parent selector matched 0 nodes" };
  }

  const firstParent = parents.snapshotItem(0);
  const children = document.evaluate(
    relative,
    firstParent,
    null,
    XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
    null,
  );

  return {
    parentCount: parents.snapshotLength,
    childCountInFirstParent: children.snapshotLength,
    firstItemText: children.snapshotItem(0)?.textContent?.trim(),
    firstItemHref: children.snapshotItem(0)?.getAttribute("href"),
  };
})();
```

---

## POST 表单搜索

当网站使用 POST 方式提交搜索关键词时：

1. 设置 `"usePost": true`。
2. 在 `searchURL` 中将表单字段作为 Query 参数书写：
   ```text
   https://example.com/search.php?searchword=@keyword&submit=
   ```
3. Kazumi 发送请求时会自动剥离 URL 中的 Query，转为 `application/x-www-form-urlencoded` 表单请求体发送。

---

## 反反爬虫配置 (`antiCrawlerConfig`)

仅在 XPath 搜索阶段被拦截时生效：

```json
"antiCrawlerConfig": {
  "enabled": true,
  "captchaType": 1,
  "captchaDetectType": 2,
  "captchaDetectValue": "请输入验证码",
  "captchaImage": "//img[@id='captcha_img']",
  "captchaInput": "//input[@name='captcha']",
  "captchaButton": "//button[@id='submit_btn']",
  "captchaScript": ""
}
```

- **`captchaType`（验证方式）**：
  - `1`：图片验证码（弹窗展示图片并由用户输入）
  - `2`：自动点击（自动触发指定按钮完成人机验证）
  - `3`：自定义 JavaScript 脚本（执行 `captchaScript` 完成验证）
- **`captchaDetectType`（拦截检测方式）**：
  - `1`：XPath 检测（页面存在指定节点时触发）
  - `2`：文本匹配（页面包含指定字符串时触发）
  - `3`：正则表达式匹配
- **`captchaDetectValue`**：对应的检测表达式、特征文本或正则表达式。

---

## 完整 XPath 规则骨架

```json
{
  "api": "1",
  "type": "anime",
  "name": "示例站点",
  "version": "1.0",
  "muliSources": true,
  "useWebview": true,
  "useNativePlayer": true,
  "usePost": false,
  "useLegacyParser": false,
  "adBlocker": false,
  "userAgent": "",
  "baseURL": "https://example.com/",
  "searchURL": "https://example.com/search?wd=@keyword",
  "searchList": "//div[@class='search-item']",
  "searchName": "//h3/a",
  "searchResult": "//h3/a",
  "chapterRoads": "//div[@class='playlist-box']",
  "chapterResult": "//ul/li/a",
  "referer": "",
  "searchMode": "xpath",
  "chapterMode": "xpath",
  "antiCrawlerConfig": {
    "enabled": false,
    "captchaType": 1,
    "captchaImage": "",
    "captchaInput": "",
    "captchaButton": "",
    "captchaDetectType": 1,
    "captchaDetectValue": "",
    "captchaScript": ""
  }
}
```
