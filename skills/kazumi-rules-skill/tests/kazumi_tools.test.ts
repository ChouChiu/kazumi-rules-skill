import assert from "node:assert/strict";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { after, before, test } from "node:test";
import {
  decodePayload,
  encodeRule,
  validateJsonPath,
  validateRule,
  type Rule,
} from "../scripts/kazumi_rule_codec.ts";
import {
  HttpClient,
  jsonpathRead,
  normalizeUrl,
  parseChapters,
  prepareApiRequest,
  probe,
  sanitizedCurl,
} from "../scripts/kazumi_rule_probe.ts";

function baseRule(): Rule {
  return {
    api: "8",
    type: "anime",
    name: "fixture",
    version: "1.0",
    muliSources: true,
    useWebview: true,
    useNativePlayer: true,
    usePost: false,
    useLegacyParser: false,
    adBlocker: false,
    userAgent: "",
    baseURL: "https://example.com/",
    searchURL: "https://example.com/search?q=@keyword",
    searchList: "//article[@class='result']",
    searchName: "//h2/a",
    searchResult: "//h2/a",
    chapterRoads: "//div[@class='road']",
    chapterResult: "//a",
    referer: "",
    searchMode: "xpath",
    chapterMode: "xpath",
    antiCrawlerConfig: { enabled: false },
  };
}
const apiSearch = (url: string): Rule => ({
  request: { method: "GET", url, query: { q: "@keyword" } },
  listPath: "$.data[*]",
  namePath: "$.name",
  sourcePath: "$.source",
});
const apiChapters = (url: string): Rule => ({
  request: { method: "GET", url, query: { id: "@source" } },
  format: "nested",
  roadsPath: "$.data.roads[*]",
  roadNamePath: "$.name",
  episodesPath: "$.episodes[*]",
  episodeNamePath: "$.name",
  episodeUrlPath: "$.url",
});

test("legacy XPath defaults to XPath", () => {
  const rule = baseRule();
  rule.api = "7";
  delete rule.searchMode;
  delete rule.chapterMode;
  assert.deepEqual(validateRule(rule), []);
});
test("API-only and mixed rules validate", () => {
  for (const [searchMode, chapterMode] of [
    ["api", "api"],
    ["api", "xpath"],
    ["xpath", "api"],
  ]) {
    const rule = {
      ...baseRule(),
      searchMode,
      chapterMode,
      searchApiConfig: apiSearch("https://example.com/api/search"),
      chapterApiConfig: apiChapters("https://example.com/api/chapter"),
    };
    assert.deepEqual(validateRule(rule), []);
  }
});
test("API mode requires level 8", () => {
  const rule = {
    ...baseRule(),
    api: "7",
    searchMode: "api",
    searchApiConfig: apiSearch("https://example.com/api/search"),
  };
  assert(
    validateRule(rule).includes(
      "API search/chapter mode requires api level 8 or newer",
    ),
  );
});
test("XPath predicates preserve quotes", () => {
  const rule = { ...baseRule(), searchList: "//article[@class=result]" };
  assert(
    validateRule(rule).some((error) =>
      error.includes("unsupported or unquoted predicate"),
    ),
  );
});
test("restricted JSONPath", () => {
  for (const path of ["$", "$.data[*]", "$['play-sources'][0]"])
    assert.equal(validateJsonPath(path), null);
  for (const path of [
    "$..data",
    "$.data[?(@.ok)]",
    "$.data[0:2]",
    "$.data.length()",
  ])
    assert.notEqual(validateJsonPath(path), null);
});
test("Kazumi link variants", () => {
  const rule = baseRule(),
    payload = encodeRule(rule),
    urlsafe = Buffer.from(JSON.stringify(rule)).toString("base64url");
  for (const value of [
    `KAZUMI://${payload}`,
    `kazumi:${urlsafe}`,
    `kazumi://${encodeURIComponent(payload)}`,
    `kazumi://${payload.slice(0, 20)}\n${payload.slice(20)}`,
  ])
    assert.deepEqual(decodePayload(value), rule);
});
test("JSONPath reads Unicode quoted fields", () => {
  const doc = { data: { items: [1, 2] }, 中文字段: "值" };
  assert.deepEqual(jsonpathRead(doc, "$.data.items[*]"), [1, 2]);
  assert.deepEqual(jsonpathRead(doc, "$['中文字段']"), ["值"]);
});
test("nested and delimited chapters", () => {
  const rule = baseRule();
  rule.chapterApiConfig = {
    format: "delimited",
    roadNamesPath: "$.names",
    roadEpisodesPath: "$.episodes",
    roadSeparator: "$$$",
    episodeSeparator: "#",
    fieldSeparator: "$",
  };
  const [roads, diagnostics] = parseChapters(
    JSON.stringify({
      names: "A$$$B",
      episodes: "01$http://cdn/1.m3u8#bad$$$正片$http://cdn/2.m3u8",
    }),
    "api",
    rule,
    "id",
    rule.baseURL,
  );
  assert.deepEqual(
    roads.map((road) => road.name),
    ["A", "B"],
  );
  assert.equal(diagnostics.length, 1);
  rule.chapterApiConfig = {
    format: "nested",
    roadsPath: "$.data.roads[*]",
    roadNamePath: "",
    episodesPath: "$.episodes[*]",
    episodeNamePath: "$.name",
    episodeUrlPath: "",
    variables: { slug: "$.data.slug" },
    episodePage: {
      url: "/play/@slug",
      query: { r: "@roadNumber", e: "@episodeIndex" },
    },
  };
  const [nested] = parseChapters(
    JSON.stringify({
      data: {
        slug: "abc",
        roads: [{ episodes: [{ name: "01" }, { name: "02" }] }],
      },
    }),
    "api",
    rule,
    "source",
    rule.baseURL,
  );
  assert.equal(
    nested[0].episodes[1].url,
    "https://example.com/play/abc?r=1&e=1",
  );
});
test("request and curl redact secrets", () => {
  const request = prepareApiRequest(
    {
      method: "POST",
      url: "https://example.com/api/@source",
      headers: { Authorization: "Bearer secret" },
      query: { access_token: "query-secret" },
      bodyType: "json",
      body: { nested: { token: "secret" }, id: "@source" },
    },
    { source: "a/b" },
  );
  const curl = sanitizedCurl(request);
  assert(request.url.includes("a%2Fb"));
  assert(!curl.includes("Bearer secret"));
  assert(!curl.includes("query-secret"));
  assert(!curl.includes('"token":"secret"'));
});
test("URL normalization preserves required protocols", () => {
  assert.equal(
    normalizeUrl("http://example.com/", "/play/1"),
    "http://example.com/play/1",
  );
  assert.equal(
    normalizeUrl("https://example.com/", "http://cdn.other/play"),
    "http://cdn.other/play",
  );
  assert.equal(
    normalizeUrl("https://example.com/", "http://example.com:8080/play"),
    "http://example.com:8080/play",
  );
});

let base = "";
const server = createServer(
  async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url!, base);
    const send = (body: string, type = "text/html") => {
      res.writeHead(200, { "content-type": `${type}; charset=utf-8` });
      res.end(body);
    };
    if (req.method === "GET" && url.pathname === "/search")
      send(
        '<article class="result"><h2><a href="/detail/1">Fixture</a></h2></article>',
      );
    else if (req.method === "GET" && url.pathname === "/detail/1")
      send('<div class="road"><a href="/play/1">01</a></div>');
    else if (req.method === "GET" && url.pathname === "/api/search")
      send(
        JSON.stringify({
          data: [
            {
              name: "Fixture",
              source:
                url.searchParams.get("kind") === "url"
                  ? `${base}/detail/1`
                  : "1",
            },
          ],
        }),
        "application/json",
      );
    else if (req.method === "GET" && url.pathname === "/api/chapter")
      send(
        JSON.stringify({
          data: {
            roads: [{ name: "A", episodes: [{ name: "01", url: "/play/1" }] }],
          },
        }),
        "application/json",
      );
    else if (req.method === "GET" && url.pathname === "/play/1")
      send('<script>const src="https://cdn.example/video.m3u8";</script>');
    else if (
      req.method === "GET" &&
      url.pathname === "/cookie-result" &&
      req.headers.cookie?.includes("session=fixture")
    )
      send('{"cookie":true}', "application/json");
    else if (req.method === "POST" && url.pathname === "/post-form") {
      let body = "";
      for await (const chunk of req) body += chunk;
      if (
        url.search === "?page=1" &&
        req.headers["x-test"] === "ok" &&
        body === "q=Fixture"
      ) {
        res.writeHead(302, {
          "set-cookie": "session=fixture; Path=/",
          location: "/cookie-result",
        });
        res.end();
      } else {
        res.writeHead(400).end();
      }
    } else if (req.method === "POST" && url.pathname === "/post-json") {
      let body = "";
      for await (const chunk of req) body += chunk;
      send(JSON.stringify({ received: JSON.parse(body) }), "application/json");
    } else res.writeHead(404).end();
  },
);
before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("missing address");
  base = `http://127.0.0.1:${address.port}`;
});
after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

test("probe supports all mode combinations", async () => {
  for (const [searchMode, chapterMode] of [
    ["xpath", "xpath"],
    ["api", "api"],
    ["api", "xpath"],
    ["xpath", "api"],
  ]) {
    const rule = {
      ...baseRule(),
      baseURL: `${base}/`,
      searchMode,
      chapterMode,
      searchURL: `${base}/search?q=@keyword`,
      searchApiConfig: apiSearch(
        `${base}/api/search?kind=${chapterMode === "xpath" ? "url" : "id"}`,
      ),
      chapterApiConfig: apiChapters(`${base}/api/chapter`),
    };
    const report = await probe(rule, {
      keyword: "Fixture",
      timeout: 5,
      resultIndex: 0,
      maxChapters: 5,
      maxMedia: 5,
      maxIframes: 3,
      probeIframe: false,
    });
    assert.equal(
      report.ok,
      true,
      `${searchMode}/${chapterMode}: ${JSON.stringify(report)}`,
    );
  }
});
test("HTTP handles POST, headers, redirects, cookies, JSON and form", async () => {
  const client = new HttpClient({ userAgent: "", referer: "" }, 5);
  const form = prepareApiRequest(
    {
      method: "POST",
      url: `${base}/post-form`,
      headers: { "X-Test": "ok" },
      query: { page: 1 },
      bodyType: "form",
      body: { q: "@keyword" },
    },
    { keyword: "Fixture" },
  );
  const [raw, url] = await client.fetch(form);
  assert.deepEqual(JSON.parse(raw), { cookie: true });
  assert.equal(url, `${base}/cookie-result`);
  const jsonRequest = prepareApiRequest(
    {
      method: "POST",
      url: `${base}/post-json`,
      bodyType: "json",
      body: { keyword: "@keyword" },
    },
    { keyword: "Fixture" },
  );
  assert.deepEqual(JSON.parse((await client.fetch(jsonRequest))[0]), {
    received: { keyword: "Fixture" },
  });
});
