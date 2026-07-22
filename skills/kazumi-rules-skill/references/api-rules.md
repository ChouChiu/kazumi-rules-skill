# API Level 8 Rules

## Contents

- [Modes and requests](#modes-and-requests)
- [Restricted JSONPath](#restricted-jsonpath)
- [Search configuration](#search-configuration)
- [Nested chapter configuration](#nested-chapter-configuration)
- [Delimited chapter configuration](#delimited-chapter-configuration)
- [Construct playback pages](#construct-playback-pages)
- [Full API-only skeleton](#full-api-only-skeleton)

## Modes and requests

Set `searchMode` or `chapterMode` to `api` and set the rule `api` to `8`. Configure each API request with:

```json
{
  "method": "GET",
  "url": "https://example.com/api/search",
  "headers": {},
  "query": {"q": "@keyword"},
  "bodyType": "none"
}
```

Support GET and POST. For POST, set `bodyType` to `json` or `form` and provide `body`. Ignore configured bodies for GET. Template exact string values preserve the original value type; embedded variables render as strings. URL template values are percent-encoded.

## Restricted JSONPath

Support only root `$`, dot fields, quoted bracket fields, numeric indexes, and wildcards:

```text
$
$.data.videos[*]
$.data.videos[0]
$['data']['play-sources'][0]
```

Reject recursive descent (`$..videos`), filters, slices, functions, and expressions. Search `namePath` and `sourcePath` are relative to each node selected by `listPath`. Chapter road and episode paths are relative to their current nodes.

## Search configuration

```json
{
  "searchMode": "api",
  "searchApiConfig": {
    "request": {
      "method": "GET",
      "url": "https://example.com/api/search",
      "query": {"q": "@keyword", "pageSize": 20}
    },
    "listPath": "$.data.videos[*]",
    "namePath": "$.name",
    "sourcePath": "$.id"
  }
}
```

Extract the value required by the next phase as `sourcePath`. For an API chapter phase this is normally an internal ID consumed by `@source`; for an XPath chapter phase it must be a usable page URL or relative URL.

## Nested chapter configuration

```json
{
  "chapterMode": "api",
  "chapterApiConfig": {
    "request": {"method": "GET", "url": "https://example.com/api/videos/@source"},
    "format": "nested",
    "roadsPath": "$.data.playSources[*]",
    "roadNamePath": "$.name",
    "episodesPath": "$.episodes[*]",
    "episodeNamePath": "$.name",
    "episodeUrlPath": "$.url"
  }
}
```

Allow an empty `roadsPath` to treat the whole response as one road. Allow an empty `roadNamePath` to generate `播放线路N`. Require either a non-empty `episodeUrlPath` or `episodePage`.

## Delimited chapter configuration

Use `format: "delimited"` for responses containing strings such as:

```text
线路A$$$线路B
第01集$URL#第02集$URL$$$正片$URL
```

Configure `roadNamesPath`, `roadEpisodesPath`, `roadSeparator` (default `$$$`), `episodeSeparator` (default `#`), and `fieldSeparator` (default `$`). Require all separators to be non-empty. Skip malformed episode entries with diagnostics.

## Construct playback pages

Use response variables and `episodePage` when an API returns protected tokens instead of usable URLs:

```json
{
  "episodeUrlPath": "",
  "variables": {"slug": "$.data.slug"},
  "episodePage": {
    "url": "https://example.com/video/@slug/play",
    "query": {"source": "@roadIndex", "episode": "@episodeIndex"}
  }
}
```

Available variables are `@source`, configured response variables, raw `@episodeUrl`, zero-based `@roadIndex` and `@episodeIndex`, and one-based `@roadNumber` and `@episodeNumber`. Use the index convention expected by the target site.

## Full API-only skeleton

```json
{
  "api": "8",
  "type": "anime",
  "name": "example",
  "version": "1.0",
  "muliSources": true,
  "useWebview": true,
  "useNativePlayer": true,
  "usePost": false,
  "useLegacyParser": false,
  "adBlocker": false,
  "userAgent": "",
  "baseURL": "https://example.com/",
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
    "request": {"method": "GET", "url": "https://example.com/api/search", "query": {"q": "@keyword"}},
    "listPath": "$.data[*]",
    "namePath": "$.name",
    "sourcePath": "$.id"
  },
  "chapterApiConfig": {
    "request": {"method": "GET", "url": "https://example.com/api/videos/@source"},
    "format": "nested",
    "roadsPath": "$.data.roads[*]",
    "roadNamePath": "$.name",
    "episodesPath": "$.episodes[*]",
    "episodeNamePath": "$.name",
    "episodeUrlPath": "$.url"
  },
  "antiCrawlerConfig": {"enabled": false, "captchaType": 1, "captchaImage": "", "captchaInput": "", "captchaButton": "", "captchaDetectType": 1, "captchaDetectValue": "", "captchaScript": ""}
}
```
