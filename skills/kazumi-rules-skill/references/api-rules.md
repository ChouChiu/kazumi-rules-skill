# Kazumi API Level 8 规则开发

## 概述与版本要求

- 只要 `searchMode` 或 `chapterMode` 任一阶段设置为 `"api"`，规则根属性 `api` 必须设为 `"8"`。
- 旧版 XPath 字段在 API 模式下保留为空字符串 `""`。
- API 规则直接请求服务端的 JSON 接口，不受前端 HTML 样式变动影响。

---

## 接口请求配置 (`Request`)

每一个 API 请求对象（`searchApiConfig.request` 或 `chapterApiConfig.request`）具备以下结构：

```json
{
  "method": "GET",
  "url": "https://example.com/api/v1/search",
  "headers": {},
  "query": {
    "q": "@keyword",
    "page": 1,
    "limit": 20
  },
  "bodyType": "none"
}
```

- **`method`**：`"GET"` 或 `"POST"`。
- **`url`**：请求基础 URL，支持包含模板变量（如 `https://example.com/api/video/@source`），会自动进行 URL 编码。
- **`headers`**：请求头 JSON 对象（键值对）。如无特殊防盗链或鉴权需求，尽量留空。
- **`query`**：URL 查询参数 JSON 对象。键与值均支持模板变量。
- **`bodyType`**：
  - `"none"`：无请求体（GET 请求固定为 none）。
  - `"json"`：JSON 请求体，需配合 `"body": { ... }` 字段。
  - `"form"`：Form 表单请求体（`application/x-www-form-urlencoded`），需配合 `"body": { ... }` 字段。

---

## 受限 JSONPath 语法规范

Kazumi 仅支持受限的 JSONPath 语法子集：

| 表达式写法 | 含义 | 是否支持 |
|---|---|---|
| `$` | 根节点 | 支持 |
| `$.data.videos` | 读取对象字段属性 | 支持 |
| `$.data.videos[*]` | 读取数组中的所有元素（通配符） | 支持 |
| `$.data.videos[0]` | 读取指定数组下标元素 | 支持 |
| `$['play-sources']` | 带引号读取包含特殊字符的字段名 | 支持 |
| `$..videos` | 递归向下查找 | **不支持** |
| `$.videos[?(@.enabled)]` | 表达式条件过滤 | **不支持** |
| `$.videos[0:2]` | 数组切片 | **不支持** |
| `$.videos.length()` | 函数或计算表达式 | **不支持** |

> [!IMPORTANT]
> - 所有 JSONPath 必须以 `$` 开头。
> - `namePath`、`sourcePath` 均相对于 `listPath` 匹配出的单个条目，不要在相对路径中重复外层结构。
> - 选集中的 `episodeNamePath`、`episodeUrlPath` 均相对于单个剧集节点。

---

## 搜索阶段配置 (`searchApiConfig`)

```json
"searchMode": "api",
"searchApiConfig": {
  "request": {
    "method": "GET",
    "url": "https://example.com/api/videos/search",
    "query": {
      "q": "@keyword",
      "pageSize": 20
    },
    "bodyType": "none"
  },
  "listPath": "$.data.videos[*]",
  "namePath": "$.name",
  "sourcePath": "$.id"
}
```

- **`@keyword`**：自动替换为用户输入的搜索词。
- **`sourcePath`**：提取下一步选集阶段所需的来源标识。
  - 若选集为 API 模式：通常提取内部 ID 或 slug，供选集请求中的 `@source` 使用。
  - 若选集为 XPath 模式：必须提取出可直接访问的目标页面完整 URL 或相对 URL。

---

## 选集阶段配置 (`chapterApiConfig`)

### 1. 嵌套 JSON 格式 (`format: "nested"`)

适用于返回标准嵌套列表结构的接口：

```json
"chapterMode": "api",
"chapterApiConfig": {
  "request": {
    "method": "GET",
    "url": "https://example.com/api/videos/@source",
    "bodyType": "none"
  },
  "format": "nested",
  "roadsPath": "$.data.playSources[*]",
  "roadNamePath": "$.name",
  "episodesPath": "$.episodes[*]",
  "episodeNamePath": "$.name",
  "episodeUrlPath": "$.url"
}
```

- **`@source`**：自动替换为搜索阶段 `sourcePath` 提取出的值。
- **`roadsPath`**：播放线路列表路径。若整个接口只包含单一线路，可留空。
- **`roadNamePath`**：线路名称路径。若留空，Kazumi 会自动命名为 `播放线路1`、`播放线路2`。
- **`episodesPath`**：剧集列表路径（相对于单个线路节点）。
- **`episodeNamePath`**：剧集名称路径（相对于单个剧集节点）。
- **`episodeUrlPath`**：剧集播放地址路径（相对于单个剧集节点）。若接口未直接提供可用 URL，留空并配合下文的 `episodePage` 播放页模板。

---

### 2. 分隔符字符串格式 (`format: "delimited"`)

适用于返回带特殊分隔符的播放源数据（如 CMS 常见格式）：

```text
线路名: 线路A$$$线路B
剧集数据: 第01集$https://cdn.example/1.m3u8#第02集$https://cdn.example/2.m3u8$$$正片$https://cdn.example/f.m3u8
```

配置示例：

```json
"chapterMode": "api",
"chapterApiConfig": {
  "request": {
    "method": "GET",
    "url": "https://example.com/api/detail?id=@source",
    "bodyType": "none"
  },
  "format": "delimited",
  "roadNamesPath": "$.data.vod_play_from",
  "roadEpisodesPath": "$.data.vod_play_url",
  "roadSeparator": "$$$",
  "episodeSeparator": "#",
  "fieldSeparator": "$"
}
```

- **`roadSeparator`**：线路间分隔符，默认 `$$$`。
- **`episodeSeparator`**：剧集间分隔符，默认 `#`。
- **`fieldSeparator`**：集名与地址分隔符，默认 `$`。

---

## 播放页地址构造模板 (`episodePage`)

当详情接口返回的 `url` 为保护占位符（如 `"protected"`）、或需要构造网页让 Kazumi WebView 进行视频嗅探时使用：

```json
"chapterApiConfig": {
  "request": {
    "method": "GET",
    "url": "https://example.com/api/videos/@source"
  },
  "format": "nested",
  "roadsPath": "$.data.playSources[*]",
  "roadNamePath": "$.name",
  "episodesPath": "$.episodes[*]",
  "episodeNamePath": "$.name",
  "episodeUrlPath": "",
  "variables": {
    "slug": "$.data.slug",
    "vid": "$.data.videoId"
  },
  "episodePage": {
    "url": "https://example.com/video/@slug/play",
    "query": {
      "source": "@roadIndex",
      "episode": "@episodeIndex",
      "v": "@vid"
    }
  }
}
```

### 可用模板变量

| 变量 | 含义 | 说明 |
|---|---|---|
| `@source` | 搜索阶段提取的来源标识 | 来自 `sourcePath` |
| `@episodeUrl` | 原始剧集地址字符串 | 来自 `episodeUrlPath` |
| `@roadIndex` | 当前线路序号 | **从 0 开始**（0, 1, 2...） |
| `@roadNumber` | 当前线路序号 | **从 1 开始**（1, 2, 3...） |
| `@episodeIndex` | 当前剧集序号 | **从 0 开始**（0, 1, 2...） |
| `@episodeNumber` | 当前剧集序号 | **从 1 开始**（1, 2, 3...） |
| `@<自定义变量>` | `variables` 中通过 JSONPath 提取的变量 | 如 `@slug`、`@vid` |

---

## 完整 API 规则骨架

```json
{
  "api": "8",
  "type": "anime",
  "name": "TvTFun",
  "version": "1.0",
  "muliSources": true,
  "useWebview": true,
  "useNativePlayer": true,
  "usePost": false,
  "useLegacyParser": false,
  "adBlocker": false,
  "userAgent": "",
  "baseURL": "https://www.tvtfun.net/",
  "searchURL": "",
  "searchList": "",
  "searchName": "",
  "searchResult": "",
  "chapterRoads": "",
  "chapterResult": "",
  "referer": "",
  "searchMode": "api",
  "chapterMode": "api",
  "searchApiConfig": {
    "request": {
      "method": "GET",
      "url": "https://www.tvtfun.net/api/videos/search",
      "query": {
        "q": "@keyword",
        "pageSize": 20
      },
      "bodyType": "none"
    },
    "listPath": "$.data.videos[*]",
    "namePath": "$.name",
    "sourcePath": "$.id"
  },
  "chapterApiConfig": {
    "request": {
      "method": "GET",
      "url": "https://www.tvtfun.net/api/videos/@source",
      "bodyType": "none"
    },
    "format": "nested",
    "roadsPath": "$.data.playSources[*]",
    "roadNamePath": "$.name",
    "episodesPath": "$.episodes[*]",
    "episodeNamePath": "$.name",
    "episodeUrlPath": "",
    "variables": {
      "slug": "$.data.slug"
    },
    "episodePage": {
      "url": "https://www.tvtfun.net/video/@slug/play",
      "query": {
        "source": "@roadIndex",
        "episode": "@episodeIndex"
      }
    }
  },
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
