# XPath Rules

## Schema

Use these fields when the corresponding phase has mode `xpath`:

| Field | Meaning |
|---|---|
| `searchURL` | GET URL template, or POST endpoint plus form query; include `@keyword` |
| `searchList` | One node per search result |
| `searchName` | Relative selector from one search result to its title element |
| `searchResult` | Relative selector from one result to a link with `href` |
| `chapterRoads` | One node per playback road/container |
| `chapterResult` | Relative selector from one road to all episode links |

Use `usePost: true` for XPath form searches. Kazumi removes the URL query and sends its query parameters as a form body.

## Supported XPath subset

Prefer:

```text
//div
//ul//li
//a
//div[@class='item']
//div[@class~='active']
//a[@href^='/vod/']
//img[@src$='.webp']
//div[@class*='search']
//li[1]
```

Avoid browser-only expressions including `contains()`, `starts-with()`, `normalize-space()`, `substring()`, `string()`, `last()`, `text()` predicates, `and`, `or`, union `|`, axes with `::`, and parent traversal `../`.

Browser `document.evaluate` supports more syntax than Kazumi's selector. Passing in Chrome is necessary but not sufficient.

## Extract selectors

1. Make `searchList` match each repeated result node, not its shared wrapper.
2. Evaluate `searchName` and `searchResult` relative to one result. When testing a community-style selector beginning with `//` in browser JavaScript, prepend `.` for the local test only.
3. Follow the selected `searchResult` link before deriving chapter selectors.
4. Make `chapterRoads` match each complete road, and `chapterResult` match every episode link inside one road.
5. Remove item-specific indexes such as `li[12]` from repeated episode paths.

Do not use `/html/body` prefixes. Prefer stable IDs, classes, and semantic containers over positional paths.

## Relative browser check

```javascript
() => {
  const parentPath = `//li[@class='result']`;
  const raw = `//h3/a`;
  const relative = raw.startsWith('//') ? `.${raw}` : raw;
  const parents = document.evaluate(parentPath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
  const parent = parents.snapshotItem(0);
  if (!parent) return { error: 'parent selector matched 0 nodes' };
  const nodes = document.evaluate(relative, parent, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
  return { parentCount: parents.snapshotLength, childCount: nodes.snapshotLength };
}
```

## Anti-crawler configuration

Apply `antiCrawlerConfig` only to XPath search responses:

- `captchaType`: `1` image input, `2` automatic button click, `3` custom JavaScript.
- `captchaDetectType`: `1` XPath, `2` literal text, `3` regular expression.
- `captchaDetectValue`: detection expression/text/pattern.
- `captchaImage`, `captchaInput`, `captchaButton`: interaction selectors as required by the selected type.
- `captchaScript`: verification script for type 3.

If detection is empty, Kazumi falls back to configured image/button selectors. Test the interaction in Kazumi; a static HTTP probe cannot complete WebView verification.
