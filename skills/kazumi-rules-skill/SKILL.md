---
name: kazumi-rules-skill
description: "Create, validate, encode, and test Kazumi anime app rules as a single JSON object using Chrome DevTools MCP, bundled Python tools, and Kazumi-compatible basic XPath. Use when asked to write a Kazumi rule, scrape an anime website for Kazumi, extract XPath for a video site, debug Kazumi rule issues, fix rule XPath not matching, validate base64/kazumi:// links, or test search/chapter/video parsing. Covers browser navigation, XPath extraction for searchList/searchName/searchResult/chapterRoads/chapterResult, api levels 1-7, base64 encoding, link export, and live rule probing."
---

# Kazumi Rules Skill

Guide for LLM to write and debug XPath rules for [Kazumi](https://github.com/Predidit/Kazumi) using [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp).

## Kazumi Rule System Overview

Kazumi is a cross-platform anime app. Its rule system uses JSON files with XPath expressions to scrape anime websites — search, list results, parse chapters, and extract video URLs. Each rule is one JSON object defining how to interact with a specific anime website.

**Rule payload shape:** Output exactly one JSON object for one rule. Do not wrap it in an array. A valid export starts with `{` and ends with `}`, not `[` / `]`.

**Key XPath fields in a rule:**

| Field | Purpose |
|-------|---------|
| `searchList` | XPath to locate each search result item node |
| `searchName` | XPath (relative to `searchList`) to extract each result's title |
| `searchResult` | XPath (relative to `searchList`) to extract the link to detail/play page |
| `chapterRoads` | XPath to locate each playback route / playlist container on detail page |
| `chapterResult` | XPath (relative to `chapterRoads`) to extract each chapter link |

**Full JSON rule structure (example: qifun, api:7):**

```json
{
  "api": "7",
  "type": "anime",
  "name": "qifun",
  "version": "2.1",
  "muliSources": true,
  "useWebview": true,
  "useNativePlayer": true,
  "usePost": false,
  "useLegacyParser": false,
  "adBlocker": false,
  "userAgent": "",
  "baseURL": "https://www.qifun.cc/",
  "searchURL": "https://www.qifun.cc/vodsearch/-------------.html?wd=@keyword",
  "searchList": "//div[@class='row gutter-20']",
  "searchName": "//h6[@class='title']",
  "searchResult": "//a",
  "chapterRoads": "//div[@id='tagContent']//div",
  "chapterResult": "//div/a",
  "referer": "",
  "antiCrawlerConfig": {
    "enabled": true,
    "captchaType": 1,
    "captchaImage": "//img[@class='mac_verify_img']",
    "captchaInput": "//input",
    "captchaButton": "//input[@class='verify_submit submit_btn']",
    "captchaDetectType": 1,
    "captchaDetectValue": "",
    "captchaScript": ""
  }
}
```

**Important:** Do NOT use `@keyword` in XPath fields — `@keyword` is only for `searchURL`. XPath fields must be valid standalone expressions.

**How relative XPath works in Kazumi:** `searchName` / `searchResult` / `chapterResult` are evaluated from within each node returned by `searchList` / `chapterRoads`. Community rules commonly use `//h3` style for these relative fields. In browser DevTools, a leading `//` is absolute, so verification snippets below normalize relative fields to `.//h3` only for local testing. Keep the final Kazumi rule in the community-compatible `//h3` style unless the user asks for strict XPath syntax.

### Kazumi-Compatible XPath Subset

Kazumi uses the Dart `xpath_selector` parser, which supports basic XPath syntax and CSS-style attribute selector operators. Browser DevTools supports a larger XPath dialect than Kazumi, so passing `document.evaluate` in Chrome is necessary but not sufficient.

**Use these XPath forms by default:**

| Intent | Prefer |
|--------|--------|
| Descendant element | `//div`, `//ul//li`, `//a` |
| Direct child chain | `//div/ul/li/a` |
| Exact attribute | `//div[@class='item']` |
| Attribute contains word | `//div[@class~='active']` |
| Attribute starts with | `//a[@href^='/vod/']` |
| Attribute ends with | `//img[@src$='.webp']` |
| Attribute contains substring | `//div[@class*='search']` |
| Simple positional narrowing | `//div[1]`, `//li/a[1]` only when unavoidable |

**Do not emit advanced browser-only XPath unless the user explicitly asks to experiment in Kazumi:**

| Avoid | Use Instead |
|-------|-------------|
| `contains(@class, 'item')` | `[@class*='item']` or `[@class~='item']` |
| `starts-with(@href, '/vod')` | `[@href^='/vod']` |
| `substring(...)`, `normalize-space(...)`, `string(...)`, `last()` | Narrow with tags and supported attribute predicates |
| `text()` predicates such as `//a[text()='播放']` | Select the element with tag/attribute, then let Kazumi read text |
| Union `//a | //button` | Pick one stable path and verify it |
| Parent/sibling/ancestor axes like `../`, `following-sibling::`, `ancestor::` | Start from the repeated container and walk downward |
| Boolean predicates with `and`, such as `//a[@class='x' and @href='/y']` | Pick the single most stable attribute, or narrow with a downward tag path |
| Complex boolean predicates with `or` | Pick one stable path and verify it |

If a selector needs unsupported syntax to be precise, choose a broader Kazumi-compatible XPath that returns the right repeated nodes after testing. Prefer stable over clever.

### Advanced Options

- **`usePost`**: Set `true` when the site uses POST for search. Determine `searchURL` via the Network panel (see POST searchURL section below).
- **`userAgent`**: Optional custom User-Agent string.
- **`referer`**: If videos won't play, set this to the `baseURL` value. Check the current KazumiRules API table before publishing; current public rules include `referer` alongside api 3+ features.
- **`useLegacyParser`**: (api >= 3) Enable for iframe-based or WebView parser-sensitive sites where the default JS hook parser fails. Keep it enabled when real Kazumi playback requires LegacyParser, even if a static probe can see media URLs in the HTML.
- **`adBlocker`**: (api >= 5) Set `true` to filter HLS ad segments during playback. Available from Kazumi 1.9.3+.
- **`antiCrawlerConfig`**: (api >= 6) For sites with CAPTCHA verification. Use `captchaImage`, `captchaInput`, and `captchaButton` for image CAPTCHA filling. Default to api 7 and include CAPTCHA-state detection fields (`captchaDetectType`, `captchaDetectValue`, `captchaScript`) so conditional CAPTCHA pages are handled. Downgrade only when the user explicitly needs compatibility with older Kazumi versions.
- **`useNativePlayer`**: Enable by default; disable if videos fail to load.

## Prerequisites

chrome-devtools MCP server must be running. Verify with `list_pages` — if unavailable, the server is not configured.

If not configured, instruct the user to add to their MCP config:

```json
"chrome-devtools": {
  "type": "local",
  "command": ["npx", "-y", "chrome-devtools-mcp@latest"]
}
```

## Bundled Python Tools

Use the bundled scripts before handing a rule to the user. They use only Python standard library modules, so no package install is required.

| Tool | Purpose | Use When |
|------|---------|----------|
| `scripts/kazumi_rule_codec.py` | Load a rule from JSON, raw base64, or `kazumi://`; reject array payloads; validate required fields and unsupported XPath; emit normalized JSON and a verified import link | Before Phase 8 export, or when debugging broken base64/import links |
| `scripts/kazumi_rule_probe.py` | Fetch the live site, test search results, open one result, extract chapter roads/results, and inspect one episode page for direct media or iframe hints | Before final delivery when network access is allowed, or when user reports search/chapter/playback failures |

**Codec examples:**

```bash
python3 scripts/kazumi_rule_codec.py /tmp/kazumi-rule.json --output /tmp/kazumi-rule.normalized.json --link-output /tmp/kazumi-rule.link
python3 scripts/kazumi_rule_codec.py 'kazumi://eyJhcGkiOiI3IiwidHlwZSI6...' --report
```

**Probe example:**

```bash
python3 scripts/kazumi_rule_probe.py /tmp/kazumi-rule.json --keyword "葬送的芙莉莲" --probe-iframe --report-output /tmp/kazumi-probe.json
```

Interpret `kazumi_rule_probe.py` results:

- `search.ok=false` → fix `searchURL` or `searchList`.
- `playlist.ok=false` → fix `searchResult`, `chapterRoads`, or `chapterResult`.
- `parse.ok=true` with `directMediaUrls` → episode page exposes a direct media URL; this does not prove LegacyParser can be disabled.
- `parse.ok=true` only after iframe probing, or `suggestEnableLegacyParser=true` → set `"useLegacyParser": true` and retest in Kazumi.
- `parse.ok=false` with iframe or JavaScript-heavy pages → Python cannot execute the page; verify with Kazumi/WebView and consider `"useLegacyParser": true`.
- Do not turn off `"useLegacyParser"` only because the Python probe found `directMediaUrls`. Kazumi playback testing is authoritative.

## Workflow: Writing a Kazumi Rule

### Phase 1: Navigate & Explore Target Site

1. **Navigate to the target site's search page:**
   ```
   navigate_page(url: "https://target-site.com/")
   ```

2. **Perform a test search** to trigger search results:
   - Use `take_snapshot` to find the search input element
   - Use `fill(uid: "...", value: "任意番剧名")` to type a keyword
   - Use `click` on the search button, or `press_key(key: "Enter")`
   - Use `wait_for(text: ["expected result text"])` to confirm search results loaded

3. **🔴 CHECKPOINT: Detect unsupported site types.** Kazumi cannot scrape SPA, JS-rendered, or API-search sites. Detect and STOP early:

   **SPA (Single Page Application):**
   - Run: `evaluate_script(function: "() => { const el = document.querySelector('#root, #app, #__next, #__nuxt'); const text = document.body.innerText.trim().length; return (el && el.children.length > 0 && text < 200) ? 'SPA DETECTED (body text: ' + text + ' chars)' : 'OK'; }")`
   - Returns `SPA DETECTED` → content loaded client-side by JS framework; Kazumi parser sees empty page → **STOP and report.**
   - Also check: URL contains `/#/` hash routing → SPA marker → **STOP.**

   **JS-rendered search results:**
   - Perform search; check if page URL changed (`evaluate_script(function: "() => window.location.href")` before and after).
   - URL unchanged AND results appeared → content fetched via JS/AJAX, not server-rendered → **STOP.**
   - Fallback: take `take_snapshot` after page load (before search). If results container is empty until JS runs → **STOP.**

   **API-based search:**
   - After search, run `list_network_requests(resourceTypes: ["fetch", "xhr"])`.
   - Find requests returning JSON (e.g., `/api/search?...`, content-type `application/json`).
   - Use `get_network_request(reqid: <id>)` to confirm JSON response body → **STOP.**
   - Kazumi rules require server-rendered HTML; JSON API responses cannot be parsed via XPath.

   All three checks pass → site is server-rendered HTML, proceed.

4. **🔴 CHECKPOINT: Verify the site is usable for rule development:**
   - Check for CAPTCHA or redirects after search
   - If CAPTCHA blocks search but the page exposes image/input/button elements → collect selectors and continue with `"api": "7"` + `antiCrawlerConfig`; tell the user CAPTCHA handling must be tested in Kazumi.
   - Fill `captchaDetectType` / `captchaDetectValue` / `captchaScript` so Kazumi can detect whether the current page is in CAPTCHA state.
   - If CAPTCHA blocks DOM inspection or cannot be represented by image/input/button selectors → site not suitable for rule development; **STOP and report to user.**
   - If site navigation/ad redirects → site unsupported; **STOP.**
   - Only proceed if search works cleanly with visible result items.

### Phase 2: Determine searchURL

**For GET-based search (most common):**
- After performing a search in Phase 1, get the current URL:
  ```
  evaluate_script(function: "() => window.location.href")
  ```
- The URL will contain the URL-encoded search keyword
- Replace the encoded keyword with `@keyword`
- Example: `https://site.com/search?wd=%E7%B4%AB%E7%BD%97%E5%85%B0` → `https://site.com/search?wd=@keyword`
- **If the URL doesn't contain the search keyword:** The site may use POST or JS-based navigation — check Network panel for a POST request (below).

**For POST-based search:**
- Navigate to the search page, perform a search
- Use `list_network_requests(resourceTypes: ["fetch", "xhr", "document"])` to find the POST request
- Use `get_network_request(reqid: <id>)` to examine request payload
- Construct: `baseURL/search_endpoint?param=@keyword`
- Set `"usePost": true` in the rule JSON

### Phase 3: Extract searchList XPath

1. **Navigate to search results** (re-perform search if needed).

2. **Take a snapshot** to understand the DOM structure:
   ```
   take_snapshot(verbose: false)
   ```

3. **Use `evaluate_script` to find the result item XPath.** Execute JS to test XPath candidates. The goal: make `searchList` return one node per search result, not a single outer wrapper.

   Test candidates iteratively (substitute `<YOUR_XPATH_CANDIDATE>` each time; use backticks if XPath contains single quotes):
   ```
   evaluate_script(function: "() => { const xp = `<YOUR_XPATH_CANDIDATE>`; const nodes = document.evaluate(xp, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null); return nodes.snapshotLength + ' result item nodes'; }")
   ```

4. **Verification checklist for searchList XPath:**
    - Returns N nodes for N visible search results
    - Each matched node highlights one complete result item
    - Use attribute-based XPath: `//ul[@class='result-list']` over `//div[1]/div[2]/ul`
    - **If searchList returns 0 nodes:** The XPath is wrong, or the page did not load results — try `take_screenshot`, `wait_for`, then retest
    - **If searchList returns 1 wrapper node:** Append the repeated child selector, e.g. `//li` or `//div[@class='item']`
    - **If searchList returns extra nodes:** Add a class/attribute filter or choose a narrower repeated child selector
    
    If children are `<li>`, append `//li`; if `<div>`, append `//div`. Final form: `//ul[@class='results']//li` or `//div[@class='items']//div`.

   **🔴 CHECKPOINT: Search result item XPath verified.** Confirm `evaluate_script` returns the same count as visible search results. Proceed only after this XPath works.

### Phase 4: Extract searchName XPath (relative to searchList)

After `searchList` locates the container, `searchName` is applied to each result item.

1. **Take a snapshot** focused on a single search result item.

2. **Use `evaluate_script`** to test XPath against one item. Substitute `<YOUR_searchList_XPATH>` with your actual searchList expression and `<YOUR_searchName_CANDIDATE>` with what you're testing. **Escaping tip:** if your XPath uses single quotes like `@class='foo'`, wrap the JS string in backticks or double quotes to avoid conflicts.
   ```
   evaluate_script(function: "() => { const searchList = `<YOUR_searchList_XPATH>`; const raw = `<YOUR_searchName_CANDIDATE>`; const searchName = raw.startsWith('//') ? '.' + raw : raw; const items = document.evaluate(searchList, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null); if (!items.snapshotLength) return 'searchList matched 0 items'; const first = items.snapshotItem(0); return document.evaluate(searchName, first, null, XPathResult.STRING_TYPE, null).stringValue.trim() || 'NO MATCH'; }")
   ```
    Iterate until it returns the expected title text.
    - **If NO MATCH:** The XPath is evaluating from wrong context — try starting from the container child level; also check if the title is inside nested `<span>` or `<strong>` elements
    - **If returns wrong text:** The XPath matches multiple text nodes — add a position filter or more specific attribute selector

3. **The searchName XPath** should work when evaluated against a single result item node. Example: if `searchList = "//div[@class='items']//div"` and a full path to the name is `//div[@class='items']//div[1]/a/h3`, the `searchName` could be `//a/h3`.

### Phase 5: Extract searchResult XPath (relative)

`searchResult` determines which page (detail vs play) the app navigates to.

1. **Inspect each result item** — look for clickable elements:
   - A "详情" (detail) button → leads to detail page with chapter list
   - A "立即播放" (play) button → leads directly to play page
   - The title itself is clickable → same as the name link

2. **Choose based on which page has the better chapter/playlist structure:**

    - **If detail page has chapters:** Click the detail button, use its XPath as `searchResult`. Then Phase 6's `chapterRoads/chapterResult` operate on the detail page.
    - **If no detail button (title-only clickable):** `searchResult` should match `searchName`'s path. The linked page becomes the target for Phase 6.
    - **If neither page has chapters (direct-play only):** Set `chapterRoads = ""` and `chapterResult = ""`. This site may be a direct video-hosting page rather than an anime catalog — proceed if user confirms, otherwise the site may be unsuitable.

3. **Must be resolvable from within a searchList item** (same as searchName).

4. **Verify navigation.** Use Chrome DevTools MCP to click one result and confirm the browser lands on the expected page (detail view or play view):
    - `take_snapshot` → find the uid of the first result's link
    - `click(uid: "...")` on that link
    - `wait_for(text: ["chapter/playlist indicator"])` to confirm navigation succeeded
    - `take_screenshot` if needed to visually verify the target page

   **🔴 CHECKPOINT: Navigation verified.** Confirm browser lands on expected page (detail or play). The target page determines Phase 6's chapter structure. Proceed only after click-through works.

### Phase 6: Extract chapterRoads & chapterResult XPath

On the detail/play page (determined by `searchResult`):

1. **Take a snapshot** of the chapter/playlist area.

2. **chapterRoads:** Find the playback route / playlist container nodes.
    - Test with `evaluate_script`: the XPath should return one node per route/playlist container
    - If there is one playlist `<ul>` containing all episode `<li>` nodes, use the `<ul>` as `chapterRoads`; put the episode link path in `chapterResult`
    - If the page has multiple route `<div>` containers, use the repeated route `<div>` nodes as `chapterRoads`
    - Example: `//ul[@class='anthology-list-play size']`
    - **If chapterRoads returns 0 route containers:** The page structure may be wrapped in `<iframe>` — check with `take_snapshot` and look for iframe elements; if present, enable `"useLegacyParser": true` and retry
    - **If the page is not the expected detail/play page:** `searchResult` XPath navigated to wrong page type — return to Phase 5 and re-examine link targets

3. **chapterResult:** Relative XPath to extract each chapter's link.
   - Use `evaluate_script` to verify each route container exposes chapter links. Normalize leading `//` to `.//` only for browser testing:
     ```
     evaluate_script(function: "() => { const roadsXPath = `<YOUR_chapterRoads_XPATH>`; const raw = `<YOUR_chapterResult_CANDIDATE>`; const chapterResult = raw.startsWith('//') ? '.' + raw : raw; const roads = document.evaluate(roadsXPath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null); if (!roads.snapshotLength) return 'chapterRoads empty'; const firstRoad = roads.snapshotItem(0); const links = document.evaluate(chapterResult, firstRoad, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null); return links.snapshotLength ? 'found ' + links.snapshotLength + ' chapter links in first route' : 'no links found'; }")
     ```
   - From the full XPath, strip the `chapterRoads` prefix and any positional index like `[12]`:
     - Full: `//div[@id='tagContent']//div[2]/ul/li[12]/a`
     - chapterRoads: `//div[@id='tagContent']//div`
     - Relative chapterResult: `//ul/li/a`  (or `//div/a` for div-based structures)
   - **MUST remove per-item indices** like `li[12]` → need ALL chapters, not just one.

4. **Verify both XPath** with `evaluate_script`:
    ```
    evaluate_script(function: "() => { const roads = document.evaluate(`<YOUR_chapterRoads_XPATH>`, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null); return roads.snapshotLength + ' route containers found'; }")
    ```

   **🔴 CHECKPOINT: Chapter extraction verified.** Both `chapterRoads` and `chapterResult` return expected counts. Proceed only after both XPath work correctly.

### Phase 7: Assemble & Validate the Rule JSON

1. **🔴 CHECKPOINT: All XPath fields collected.** Before assembling JSON, confirm you have verified all 5 XPath fields:
   - `searchList` (Phase 3)
   - `searchName` (Phase 4)
   - `searchResult` (Phase 5)
   - `chapterRoads` (Phase 6)
   - `chapterResult` (Phase 6)
   - `searchURL` (Phase 2)

2. **Compose the complete JSON object** with all fields (see structure above).

3. **Validation checklist before export:**
   - `searchURL` contains `@keyword` placeholder
   - Final rule is a single JSON object, not an array of objects
   - `searchList` identifies repeated result item nodes (often ends with `//li` or a repeated item `//div`)
   - `chapterRoads` identifies route/playlist containers, while `chapterResult` identifies episode links inside each route
   - `searchName`, `searchResult` are relative to searchList
   - `chapterResult` is relative to chapterRoads
   - XPath expressions start with `//`
   - XPath expressions stay inside the Kazumi-compatible subset above; replace functions like `contains()` / `starts-with()` with attribute operators such as `*=` / `^=`
   - XPath expressions do not use boolean operators such as `and`; choose one stable attribute or narrow by tag path instead
   - No `/html/body` prefixes
   - Set `"api"` to `"7"` by default:
     - `"1"`: basic (Kazumi 1.0.0+)
     - `"2"`: POST support (Kazumi >= 1.3.0)
     - `"3"`: legacy parser / referer support in the current KazumiRules API table (Kazumi >= 1.3.6)
     - `"4"`: compatibility level used by some older rules/docs (Kazumi >= 1.6.8)
     - `"5"`: HLS ad filtering (Kazumi >= 1.9.3)
     - `"6"`: anti-crawler / CAPTCHA image/input/button support
     - `"7"`: CAPTCHA-state detection support via `captchaDetectType`, `captchaDetectValue`, and `captchaScript`
   - Use `"api": "7"` for new rules unless the user explicitly requests compatibility with an older Kazumi version; then downgrade to the highest supported api that still covers required features.

4. **Run the codec tool.** Save the rule as a single JSON object and run:
   ```bash
   python3 scripts/kazumi_rule_codec.py /tmp/kazumi-rule.json --output /tmp/kazumi-rule.normalized.json --link-output /tmp/kazumi-rule.link
   ```
   - If it reports "single JSON object, not an array" → remove the surrounding `[...]`.
   - If it reports unsupported XPath → replace the XPath before export.
   - Use the normalized JSON and link produced by this tool in Phase 8.

5. **Run the live probe when network access is available.**
   ```bash
   python3 scripts/kazumi_rule_probe.py /tmp/kazumi-rule.normalized.json --keyword "葬送的芙莉莲" --probe-iframe --report-output /tmp/kazumi-probe.json
   ```
   Continue only after search and playlist checks pass. If the probe suggests enabling `useLegacyParser`, update the rule and rerun the codec/probe tools. If real Kazumi playback requires LegacyParser, keep `"useLegacyParser": true` even when the probe finds direct media URLs.

### Phase 8: Export as Import Link

After validating the rule JSON, **you MUST execute the following steps and output the result to the user:**

1. **Write the complete rule JSON to a temp file**, then run the codec tool:
   ```bash
   python3 scripts/kazumi_rule_codec.py /tmp/kazumi-rule.json --output /tmp/kazumi-rule.normalized.json --link-output /tmp/kazumi-rule.link
   ```

2. **Read `/tmp/kazumi-rule.link`** and use that verified `kazumi://` import link. Do not hand-write base64 when the tool is available.

3. **Present the final link to the user clearly.** Output both the normalized JSON rule (for review) and the import link:

   ````markdown
   完整规则 JSON:
   
   ```json
   {"api":"7","type":"anime","name":"mysite",...}
   ```

   导入链接: `kazumi://eyJhcGkiOiI3IiwidHlwZSI6ImFuaW1lIiwibmFtZSI6...`

   在 Kazumi 导入规则测试 。
   ````

### Phase 9: 🛑 STOP — Test & Iterate with the User

After providing the import link:

1. **Ask the user to test in Kazumi:**
   - Import the rule via the `kazumi://` link
   - Search for an anime and verify results appear
   - Tap a result and verify chapters load
   - Play an episode and verify video plays

2. **If the user reports issues, iterate:**
   - "No search results" → return to Phase 3, re-examine `searchList`
   - "Results show but can't enter detail" → Phase 5, fix `searchResult`
   - "Entered detail but no chapters" → Phase 6, fix `chapterRoads` or `chapterResult`
   - "Chapters show but won't play" → try setting `"referer": "<baseURL>"`, or enable `"useLegacyParser": true`
   - "Video never loads" → check Network requests for blocked/failed resources, adjust `userAgent` if needed

3. **Re-export after each fix** with a new `kazumi://` link.

## Rule Anti-Patterns Blacklist

When writing or debugging Kazumi rules, **do NOT** do the following:

| # | Anti-Pattern | Why It's Wrong | Correct Approach |
|---|---|---|---|
| 1 | Use `@keyword` in XPath fields (`searchList`, `searchName`, etc.) | `@keyword` is only for `searchURL`; XPath fields must be standalone expressions | Use `evaluate_script` to test XPath directly — never insert `@keyword` |
| 2 | Use `/html/body` prefixes in XPath | Site layout changes break these; Kazumi ignores overly specific paths | Use attribute-based selectors: `//div[@class='items']` not `/html/body/div[1]/div[2]/div[3]` |
| 3 | Include per-item positional indices in `chapterResult` | e.g., `//li[12]/a` matches only one item, missing all others | Strip indices: `//li/a` (remove `[N]` from the path component) |
| 4 | Assume `searchResult` navigates to detail page without verifying | Some sites have only direct-play links; `chapterRoads` needs different target page | Always click-through and verify destination page (Phase 5 checkpoint) |
| 5 | Skip `wait_for` before extracting XPath | JS-rendered DOM may not be ready; XPath returns 0 elements silently | Always `wait_for(text: ["..."])` before `evaluate_script` on the target area |
| 6 | Use `searchName` XPath as `searchResult` without checking link targets | The name element may not be clickable or may link to wrong page | Always inspect the element's parent `<a>` tag or test click navigation |
| 7 | Skip `evaluate_script` verification and assume XPath works | XPath that looks correct may return 0 elements at runtime | Always run the verification `evaluate_script` snippet from each phase |
| 8 | Downgrade `"api"` without a compatibility requirement | Older api levels may omit CAPTCHA-state detection and break sites with conditional CAPTCHA | Default to `"api": "7"`; downgrade only when the user explicitly needs older Kazumi compatibility |
| 9 | Export rule without base64-encoding validation | Truncated or malformed base64 = broken import link | Always test with `echo -n '{...}' | base64` and verify no line breaks |
| 10 | Proceed through Phase 3-6 without confirming each checkpoint | Errors cascade: wrong searchList → wrong searchName → wrong chapterResult | Each phase has a 🔴 CHECKPOINT; do not skip |
| 11 | Write rule for SPA / JS-rendered / API-search site | Kazumi parser requires server-rendered HTML; SPA/API sites return empty or JSON responses | Run Phase 1 step 3 detection checks first; if detected → STOP, site unsupported |
| 12 | Wrap one rule as `[{"api":"7",...}]` | Kazumi imports one rule object; array payloads are the wrong shape for this skill's output | Output `{"api":"7",...}` exactly |
| 13 | Use advanced browser XPath functions such as `contains()`, `starts-with()`, `normalize-space()`, `text()`, boolean `and`, or union `|` | Chrome `document.evaluate` accepts more syntax than Kazumi's `xpath_selector` parser | Use simple tag paths and supported attribute operators (`=`, `~=`, `^=`, `$=`, `*=`); for multiple conditions, choose the single most stable attribute |

## Troubleshooting

Symptom → fix → fallback. See [Rule Anti-Patterns Blacklist](#rule-anti-patterns-blacklist) for prevention.

| Symptom | First Fix | Fallback |
|---------|-----------|----------|
| "no results found" in app | Re-verify `searchList` with `evaluate_script` from Phase 3 | `take_screenshot` to confirm page loaded; check for JS render delay |
| "no chapters found" | Re-verify `chapterRoads` + `chapterResult` from Phase 6 | Return to Phase 5; confirm `searchResult` navigates to detail page (not play page) |
| XPath returns 0 elements | Re-run `evaluate_script` verification snippet | `take_screenshot` to check for anti-bot/redirect; `wait_for` then retry |
| Video won't play | Set `referer` to `baseURL` value | Enable `useLegacyParser: true`; check Network tab for blocked CDN requests |
| Search triggers CAPTCHA | Configure `antiCrawlerConfig` with CAPTCHA selectors (api >= 6) | Site unsuitable — report to user, do not proceed with rule development |
| Blank page / no content in Kazumi (site works in browser) | Verify site is server-rendered HTML (not SPA / JS-rendered / API-search) | Re-run Phase 1 step 3 detection; check `list_network_requests` for JSON API calls |

## Reference

### Chrome DevTools MCP Quick Reference

All tool calls used in this skill. Each tool is documented in the [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) README.

| Task | Tool Call | Phase Used |
|------|-----------|------------|
| Navigate | `navigate_page(url: "...")` | 1, 3 |
| Page snapshot (DOM) | `take_snapshot(verbose: true)` | 1, 3, 6 |
| Screenshot | `take_screenshot(filePath: "...")` | 1, 5 |
| Click element | `click(uid: "...")` | 1, 5 |
| Fill input | `fill(uid: "...", value: "...")` | 1 |
| Press key | `press_key(key: "Enter")` | 1 |
| Execute JS | `evaluate_script(function: "() => { ... }")` | 3, 4, 5, 6 |
| Wait for text | `wait_for(text: ["..."])` | 1, 5 |
| Network requests | `list_network_requests(resourceTypes: ["fetch", "xhr"])` | 2 |
| Request details | `get_network_request(reqid: <id>)` | 2 |
| List pages | `list_pages` | Prerequisites |
| New page | `new_page(url: "...")` | Prerequisites |

### Typical XPath Patterns from Community Rules

| Pattern | Example (from real rules) |
|---------|---------------------------|
| Class-based result item | `//div[@class='vod-detail style-detail cor4 search-list']` (giriGiriLove / xfdm style) |
| Playlist container | `//ul[@class='anthology-list-play size']` (giriGiriLove / xfdm style) |
| Relative title link | `//div/div[2]/a` (giriGiriLove style) |
| Link within item | `//a` or `//div/a` (most searchResult) |
| List item links | `//li/a` (most chapterResult) |
| Class name with spaces | `//div[@class='vod-detail style-detail cor4 search-list']` (akianime) |
| Positional (avoid — fragile) | `//div/div[2]/div/div[2]/div/div/div[1]/div/div[2]/div/ul/li` (legacy style) |

## Resources

| Resource | Purpose | Type |
|----------|---------|------|
| [Kazumi Rule Development Guide](https://kazumi.app/docs/rules/develop-rules) | Official doc: rule structure, XPath semantics, api levels | Documentation |
| [Kazumi Rule Development Example](https://kazumi.app/docs/rules/develop-rules-example) | Step-by-step tutorial with screenshots | Tutorial |
| [KazumiRules Repository](https://github.com/Predidit/KazumiRules) | Community-maintained rule collection (reference implementations) | Examples |
| [Kazumi App](https://github.com/Predidit/Kazumi) | Kazumi source code and releases | Repository |
| [xpath_selector](https://github.com/simonkimi/xpath_selector) | Parser used by Kazumi; supports basic XPath and CSS-style attribute selector operators | Repository |
| [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) | MCP server enabling browser automation for XPath extraction | Tool
