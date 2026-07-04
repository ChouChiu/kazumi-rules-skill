---
name: kazumi-rules-skill
description: "Create XPath rules for the Kazumi anime app using Chrome DevTools MCP. Use when asked to write a Kazumi rule, scrape an anime website for Kazumi, extract XPath for a video site, debug Kazumi rule issues, fix rule XPath not matching, or generate kazumi:// import links. Covers full pipeline: browser navigation, DOM inspection via evaluate_script, XPath extraction for searchList/searchName/searchResult/chapterRoads/chapterResult, JSON rule assembly with api levels 1-7, base64 encoding, and kazumi:// link export."
---

# Kazumi Rules Skill

Guide for LLM to write and debug XPath rules for [Kazumi](https://github.com/Predidit/Kazumi) using [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp).

## Kazumi Rule System Overview

Kazumi is a cross-platform anime app. Its rule system uses JSON files with XPath expressions to scrape anime websites — search, list results, parse chapters, and extract video URLs. Each rule is a JSON object defining how to interact with a specific anime website.

**Key XPath fields in a rule:**

| Field | Purpose |
|-------|---------|
| `searchList` | XPath to locate the container of all search result items |
| `searchName` | XPath (relative to `searchList`) to extract each result's title |
| `searchResult` | XPath (relative to `searchList`) to extract the link to detail/play page |
| `chapterRoads` | XPath to locate the container of all chapter/playlist items on detail page |
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

**How relative XPath works in Kazumi:** `searchName` / `searchResult` / `chapterResult` are evaluated from within each container node returned by `searchList` / `chapterRoads`. Kazumi scopes the evaluation context, so community rules use `//h3` style (works because evaluation context is scoped to each container). In standard XPath, `.//h3` is the equivalent relative syntax — both work in Kazumi.

### Advanced Options

- **`usePost`**: Set `true` when the site uses POST for search. Determine `searchURL` via the Network panel (see POST searchURL section below).
- **`userAgent`**: Optional custom User-Agent string.
- **`referer`**: (api >= 4) If videos won't play, set this to the `baseURL` value. Available from Kazumi 1.6.8+.
- **`useLegacyParser`**: (api >= 3) Enable for iframe-based sites where the default JS hook parser fails.
- **`adBlocker`**: (api >= 5) Set `true` to filter HLS ad segments during playback. Available from Kazumi 1.9.3+.
- **`antiCrawlerConfig`**: (api >= 6) For sites with CAPTCHA verification. Supports image CAPTCHA (`captchaType: 1`) with XPath selectors for the CAPTCHA image, input field, and submit button.
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
   - If CAPTCHA detected → site not suitable for rule development; **STOP and report to user. Do not proceed.**
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

3. **Use `evaluate_script` to find the list container.** Execute JS to test XPath candidates. The goal: find the parent element that contains ALL search result items.

   Test candidates iteratively (substitute `<YOUR_XPATH_CANDIDATE>` each time; use backticks if XPath contains single quotes):
   ```
   evaluate_script(function: "() => { const el = document.evaluate(`<YOUR_XPATH_CANDIDATE>`, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue; return el ? el.children.length + ' children' : 'NO MATCH'; }")
   ```

4. **Verification checklist for searchList XPath:**
    - Returns a container element holding ALL search result children
    - The container's direct children correspond one-to-one with search results
    - Moving cursor over the matched element highlights all results in the UI
    - Use attribute-based XPath: `//ul[@class='result-list']` over `//div[1]/div[2]/ul`
    - **If searchList returns 0 children:** The container is wrong — try parent or grandparent elements; also try `take_screenshot` to check if page actually loaded results
    - **If searchList returns correct count but children aren't result items:** The container has extra non-result children — append a more specific child selector (e.g., `//li` or `//div[@class='item']`)
    
    If children are `<li>`, append `//li`; if `<div>`, append `//div`. Final form: `//ul[@class='results']//li` or `//div[@class='items']//div`.

   **🔴 CHECKPOINT: Search results container verified.** Confirm `evaluate_script` returns correct number of children matching search results. Proceed only after this XPath works.

### Phase 4: Extract searchName XPath (relative to searchList)

After `searchList` locates the container, `searchName` is applied to each result item.

1. **Take a snapshot** focused on a single search result item.

2. **Use `evaluate_script`** to test XPath against one item. Substitute `<YOUR_searchList_XPATH>` with your actual searchList expression and `<YOUR_searchName_CANDIDATE>` with what you're testing. **Escaping tip:** if your XPath uses single quotes like `@class='foo'`, wrap the JS string in backticks or double quotes to avoid conflicts.
   ```
   evaluate_script(function: "() => { const searchList = `<YOUR_searchList_XPATH>`; const searchName = `<YOUR_searchName_CANDIDATE>`; const items = document.evaluate(searchList, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null); if (!items.snapshotLength) return 'searchList matched 0 items'; const first = items.snapshotItem(0); return document.evaluate(searchName, first, null, XPathResult.STRING_TYPE, null).stringValue || 'NO MATCH'; }")
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

2. **chapterRoads:** Find the container of ALL chapter/playlist items.
    - Test with `evaluate_script`: the XPath should return a container whose children are chapter items
    - If children are `<li>`, append `//li`; if `<div>`, append `//div`
    - Example: `//ul[@class='anthology-list-play size']//li`
    - **If chapterRoads returns 0 items:** The page structure may be wrapped in `<iframe>` — check with `take_snapshot` and look for iframe elements; if present, enable `"useLegacyParser": true` and retry
    - **If the page is not the expected detail/play page:** `searchResult` XPath navigated to wrong page type — return to Phase 5 and re-examine link targets

3. **chapterResult:** Relative XPath to extract each chapter's link.
   - Use `evaluate_script` to locate a specific chapter link's full XPath from the chapterRoads container:
     ```
     evaluate_script(function: "() => { const roads = document.evaluate(`<YOUR_chapterRoads_XPATH>`, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null); if (!roads.snapshotLength) return 'chapterRoads empty'; const firstRoad = roads.snapshotItem(0); const links = firstRoad.querySelectorAll('a'); return links.length ? 'found ' + links.length + ' links' : 'no links found'; }")
     ```
   - From the full XPath, strip the `chapterRoads` prefix and any positional index like `[12]`:
     - Full: `//div[@id='tagContent']//div[2]/ul/li[12]/a`
     - chapterRoads: `//div[@id='tagContent']//div`
     - Relative chapterResult: `//ul/li/a`  (or `//div/a` for div-based structures)
   - **MUST remove per-item indices** like `li[12]` → need ALL chapters, not just one.

4. **Verify both XPath** with `evaluate_script`:
    ```
    evaluate_script(function: "() => { const roads = document.evaluate(`<YOUR_chapterRoads_XPATH>`, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null); return roads.snapshotLength + ' chapter items found'; }")
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
   - `searchList`, `chapterRoads` identify containers (end with `//li`, `//div`, etc.)
   - `searchName`, `searchResult` are relative to searchList
   - `chapterResult` is relative to chapterRoads
   - XPath expressions start with `//`
   - No `/html/body` prefixes
   - Set `"api"` based on minimum Kazumi version needed:
     - `"1"`: basic (Kazumi 1.0.0+)
     - `"2"`: POST support (Kazumi >= 1.3.0)
     - `"3"`: legacy parser (Kazumi >= 1.3.6)
     - `"4"`: Referer header support (Kazumi >= 1.6.8)
     - `"5"`: HLS ad filtering (Kazumi >= 1.9.3)
     - `"6"` / `"7"`: anti-crawler / CAPTCHA support
   - Pick the LOWEST api level that covers all features used. Default to `"4"` for a standard rule with `usePost: false` and `useLegacyParser: false`.

### Phase 8: Export as Import Link

After validating the rule JSON, **you MUST execute the following steps and output the result to the user:**

1. **Write the complete rule JSON to a temp file**, then run:
   ```bash
   cat /tmp/kazumi-rule.json | base64 | tr -d '\n'
   ```

   Or inline with a one-liner:
   ```bash
   echo -n '[{"api":"7","type":"anime","name":"<sitename>",...}]' | base64
   ```

2. **Take the base64 output and construct the import link:**
   ```
   kazumi://<paste_base64_output_here>
   ```

3. **Present the final link to the user clearly.** Output both the JSON rule (for review) and the import link:

   ````markdown
   Completed rule:
   ```json
   [{"api":"7","type":"anime","name":"mysite",...}]
   ```

   Import link: `kazumi://eyJhcGkiOiI3IiwidHlwZSI6...`

在 Kazumi 中点击此链接即可导入规则。
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
| 8 | Set `"api"` higher than needed | Unnecessary version bump limits compatibility with older Kazumi installs | Pick the LOWEST api level covering used features (default `"4"`) |
| 9 | Export rule without base64-encoding validation | Truncated or malformed base64 = broken import link | Always test with `echo -n '[...]' | base64` and verify no line breaks |
| 10 | Proceed through Phase 3-6 without confirming each checkpoint | Errors cascade: wrong searchList → wrong searchName → wrong chapterResult | Each phase has a 🔴 CHECKPOINT; do not skip |
| 11 | Write rule for SPA / JS-rendered / API-search site | Kazumi parser requires server-rendered HTML; SPA/API sites return empty or JSON responses | Run Phase 1 step 3 detection checks first; if detected → STOP, site unsupported |

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
| Class-based container | `//div[@class='row gutter-20']` (qifun) |
| ID-based container | `//div[@id='tagContent']//div` (qifun chapterRoads) |
| Tag + class selector | `//h6[@class='title']` (qifun searchName) |
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
| [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) | MCP server enabling browser automation for XPath extraction | Tool
