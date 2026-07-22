# Discovery and Testing

## Discover with Chrome DevTools

Use the Network panel or Chrome DevTools MCP Fetch/XHR tools to find JSON interfaces:

1. Clear requests, perform one search, and identify the new request.
2. Record method, URL, query, request headers, request body, response content type, and response JSON.
3. Repeat by opening one result and identify the chapter/detail request.
4. Identify which search response value becomes the chapter request `@source`.
5. Inspect the playback action and determine whether the chapter response contains a direct URL or requires an `episodePage` template.

Do not copy every browser header. Identify the minimum required request by reproducing it outside the browser.

## Reproduce with curl

Use `-i` for response headers, `-v` for transport/debug details, `-L` for redirects, and `--compressed` for compressed responses. Avoid pasting verbose output containing secrets into user-visible responses.

GET with encoded query:

```bash
curl --get 'https://example.com/api/search' \
  --data-urlencode 'q=紫罗兰永恒花园' \
  --data 'pageSize=20' \
  --compressed -i
```

POST JSON:

```bash
curl 'https://example.com/api/search' \
  -H 'content-type: application/json' \
  --data '{"keyword":"紫罗兰永恒花园"}' \
  --compressed -i
```

POST form:

```bash
curl 'https://example.com/search.php' \
  --data-urlencode 'searchword=紫罗兰永恒花园' \
  --compressed -i
```

Add only verified requirements such as `--referer`, `--user-agent`, `-H`, or `--cookie`. Treat Cookie, Authorization, proxy authorization, API keys, CSRF tokens, signatures, and session IDs as secrets. Show placeholders such as `<redacted>` in reports and examples.

If curl fails while the browser succeeds, compare redirects, cookies, origin/referer, content type, body encoding, dynamic signatures, and anti-bot state. If the request depends on short-lived browser state that Kazumi cannot reproduce, reject that API route and consider XPath or another source.

## Map curl to a rule

| curl | API request config |
|---|---|
| URL path | `request.url` |
| `--get --data*` | `request.query` |
| `-H` | `request.headers` |
| `--data` JSON | `bodyType: json`, `body` |
| `--data` form | `bodyType: form`, `body` |
| search value | replace with `@keyword` |
| selected result ID | replace with `@source` |

Do not place curl-only transport flags in rule JSON.

## Test in layers

1. Run curl and confirm a successful status and expected response shape.
2. Run `node scripts/kazumi_rule_codec.ts` and fix schema/selector errors.
3. Run `node scripts/kazumi_rule_probe.ts`; inspect sanitized curl, counts, generated URLs, and diagnostics.
4. Use Kazumi's rule test view to inspect raw responses, matched fragments, skipped-node diagnostics, roads, and episode URLs.
5. Test playback, preferably on Android because WebView sniffing differs by platform.

A static media URL or iframe hint does not prove playback. Preserve `useLegacyParser` when Kazumi requires it. API parsing success also does not guarantee that the final resource is available in the user's region or session.

Always give the codec a JSON file or safely supplied stdin. Never place raw JSON with XPath quotes directly in a shell command argument. After encoding, decode the generated link and compare all selector/config values with the source object, not only the payload shape.
