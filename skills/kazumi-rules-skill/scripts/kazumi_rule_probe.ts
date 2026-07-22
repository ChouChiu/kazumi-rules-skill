#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  RuleCodecError,
  SECRET_RE,
  TEMPLATE_RE,
  loadRule,
  ruleMode,
  validateJsonPath,
  validateRule,
  type Rule,
} from "./kazumi_rule_codec.ts";

export class ProbeError extends Error {}

type Attrs = Record<string, string>;
export class HtmlNode {
  children: HtmlNode[] = [];
  textParts: string[] = [];
  tag: string;
  attrs: Attrs;
  parent?: HtmlNode;
  constructor(tag: string, attrs: Attrs = {}, parent?: HtmlNode) {
    this.tag = tag;
    this.attrs = attrs;
    this.parent = parent;
  }
  text(): string {
    return [...this.textParts, ...this.children.map((child) => child.text())]
      .join(" ")
      .trim()
      .replace(/\s+/g, " ");
  }
  *descendants(): Generator<HtmlNode> {
    for (const child of this.children) {
      yield child;
      yield* child.descendants();
    }
  }
}

const VOID = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);
export function parseHtml(source: string): HtmlNode {
  const root = new HtmlNode("__document__");
  const stack = [root];
  for (const token of source.match(/<!--[\s\S]*?-->|<![^>]*>|<[^>]+>|[^<]+/g) ??
    []) {
    if (token.startsWith("</")) {
      const tag = token
        .slice(2)
        .match(/^\s*([\w:-]+)/)?.[1]
        ?.toLowerCase();
      if (tag) {
        const index = stack.findLastIndex((node) => node.tag === tag);
        if (index > 0) stack.splice(index);
      }
    } else if (
      token.startsWith("<") &&
      !token.startsWith("<!") &&
      !token.startsWith("<?")
    ) {
      const match = token.match(/^<\s*([\w:-]+)/);
      if (!match) continue;
      const tag = match[1].toLowerCase();
      const attrs: Attrs = {};
      const rest = token.slice(match[0].length, token.lastIndexOf(">"));
      for (const attr of rest.matchAll(
        /([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g,
      ))
        attrs[attr[1].toLowerCase()] = decodeEntities(
          attr[2] ?? attr[3] ?? attr[4] ?? "",
        );
      const node = new HtmlNode(tag, attrs, stack.at(-1));
      stack.at(-1)!.children.push(node);
      if (!VOID.has(tag) && !/\/\s*>$/.test(token)) stack.push(node);
    } else if (!token.startsWith("<") && token.trim())
      stack.at(-1)!.textParts.push(decodeEntities(token.trim()));
  }
  return root;
}

function decodeEntities(value: string): string {
  return value.replace(
    /&(?:amp|lt|gt|quot|#39);/g,
    (entity) =>
      ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" })[
        entity
      ]!,
  );
}

type Step = { axis: "desc" | "child"; tag: string; predicates: string[] };
function parseSteps(xpath: string): Step[] {
  const steps: Step[] = [];
  let index = 0;
  while (index < xpath.length) {
    let axis: Step["axis"] = "child";
    if (xpath.startsWith("//", index)) {
      axis = "desc";
      index += 2;
    } else if (xpath[index] === "/") index++;
    const start = index;
    let depth = 0;
    while (index < xpath.length) {
      if (xpath[index] === "[") depth++;
      else if (xpath[index] === "]") depth--;
      else if (xpath[index] === "/" && depth === 0) break;
      index++;
    }
    const token = xpath.slice(start, index).trim();
    if (!token) continue;
    const tag = token.match(/^([A-Za-z0-9_*:-]+)/)?.[1];
    if (!tag) throw new ProbeError(`unsupported XPath step: ${token}`);
    const suffix = token.slice(tag.length);
    const predicates = [...suffix.matchAll(/\[[^\]]+\]/g)].map(
      (match) => match[0],
    );
    if (suffix.replace(/\[[^\]]+\]/g, "").trim())
      throw new ProbeError(`unsupported XPath suffix: ${token}`);
    steps.push({ axis, tag: tag.toLowerCase(), predicates });
  }
  return steps;
}

export function evaluateXpath(
  context: HtmlNode,
  expression: string,
): HtmlNode[] {
  if (!expression.trim()) return [];
  let current = [context];
  for (const step of parseSteps(
    expression.startsWith("/") ? expression : `/${expression}`,
  )) {
    const next: HtmlNode[] = [];
    for (const node of current) {
      let matches = (
        step.axis === "desc" ? [...node.descendants()] : node.children
      ).filter((item) => step.tag === "*" || item.tag === step.tag);
      for (const wrapped of step.predicates) {
        const body = wrapped.slice(1, -1).trim();
        if (/^\d+$/.test(body))
          matches = matches[Number(body) - 1]
            ? [matches[Number(body) - 1]]
            : [];
        else {
          const match = body.match(
            /^@([\w:-]+)\s*(=|~=|\^=|\$=|\*=)\s*(['"])(.*?)\3$/,
          );
          if (!match)
            throw new ProbeError(`unsupported XPath predicate: [${body}]`);
          const [, attr, op, , expected] = match;
          matches = matches.filter((item) => {
            const actual = item.attrs[attr.toLowerCase()] ?? "";
            return op === "="
              ? actual === expected
              : op === "~="
                ? actual.split(/\s+/).includes(expected)
                : op === "^="
                  ? actual.startsWith(expected)
                  : op === "$="
                    ? actual.endsWith(expected)
                    : actual.includes(expected);
          });
        }
      }
      next.push(...matches);
    }
    current = next;
  }
  return current;
}

function bracketEnd(expression: string, start: number): number {
  let quote = "";
  for (let i = start + 1; i < expression.length; i++) {
    const char = expression[i];
    if (quote && char === quote && expression[i - 1] !== "\\") quote = "";
    else if (!quote && ["'", '"'].includes(char)) quote = char;
    else if (!quote && char === "]") return i;
  }
  throw new ProbeError(`JSONPath is missing ]: ${expression}`);
}
export function jsonpathRead(document: any, expression: string): any[] {
  const error = validateJsonPath(expression);
  if (error) throw new ProbeError(error);
  let values = [document];
  let index = 1;
  while (index < expression.length) {
    let part: string;
    if (expression[index] === ".") {
      const match = expression.slice(++index).match(/^[A-Za-z0-9_$-]+/)!;
      part = match[0];
      index += part.length;
    } else {
      const end = bracketEnd(expression, index);
      part = expression.slice(index + 1, end).trim();
      index = end + 1;
      if (["'", '"'].includes(part[0]))
        part =
          part[0] === '"'
            ? JSON.parse(part)
            : part.slice(1, -1).replace(/\\(['\\])/g, "$1");
    }
    const next: any[] = [];
    for (const value of values) {
      if (part === "*" && Array.isArray(value)) next.push(...value);
      else if (
        /^\d+$/.test(part) &&
        Array.isArray(value) &&
        Number(part) < value.length
      )
        next.push(value[Number(part)]);
      else if (value && typeof value === "object" && part in value)
        next.push(value[part]);
    }
    values = next;
  }
  return values;
}
const first = (document: any, expression: string): any =>
  jsonpathRead(document, expression)[0];

export function renderValue(value: any, variables: Rule, encode = false): any {
  if (typeof value === "string") {
    const exact = value.match(/^@([A-Za-z_][A-Za-z0-9_]*)$/);
    if (exact && !encode) {
      if (!(exact[1] in variables))
        throw new ProbeError(`missing template variable @${exact[1]}`);
      return variables[exact[1]];
    }
    return value.replace(TEMPLATE_RE, (_, name: string) => {
      if (!(name in variables))
        throw new ProbeError(`missing template variable @${name}`);
      const result = String(variables[name] ?? "");
      return encode ? encodeURIComponent(result) : result;
    });
  }
  if (Array.isArray(value))
    return value.map((item) => renderValue(item, variables));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        renderValue(key, variables),
        renderValue(item, variables),
      ]),
    );
  return value;
}

export function normalizeUrl(base: string, raw: string): string {
  if (!raw.trim()) return "";
  const target = new URL(raw.trim(), base);
  const baseUrl = new URL(base);
  const explicit = (value: string): string | null =>
    value.match(/^[a-z]+:\/\/[^/]+:(\d+)/i)?.[1] ?? null;
  if (
    ["http:", "https:"].includes(target.protocol) &&
    ["http:", "https:"].includes(baseUrl.protocol) &&
    target.hostname === baseUrl.hostname &&
    explicit(target.href) === explicit(baseUrl.href)
  )
    target.protocol = baseUrl.protocol;
  if (target.pathname !== "/")
    target.pathname = target.pathname.replace(/\/+$/, "");
  return target.href;
}

export type PreparedRequest = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  bodyType: string;
  includeCookies: boolean;
};
export function prepareApiRequest(
  config: Rule,
  variables: Rule,
): PreparedRequest {
  const method = String(config.method ?? "GET").toUpperCase();
  const url = new URL(renderValue(String(config.url ?? ""), variables, true));
  for (const [key, value] of Object.entries(
    renderValue(config.query ?? {}, variables),
  ))
    url.searchParams.append(key, String(value));
  const headers = Object.fromEntries(
    Object.entries(renderValue(config.headers ?? {}, variables)).map(
      ([key, value]) => [key, String(value)],
    ),
  );
  const bodyType = String(config.bodyType ?? "none");
  let body: string | undefined;
  if (method === "POST" && bodyType !== "none") {
    const value = renderValue(config.body, variables);
    if (bodyType === "json") {
      body = JSON.stringify(value);
      headers["Content-Type"] ??= "application/json";
    } else {
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new ProbeError("form body must be an object");
      body = new URLSearchParams(
        Object.entries(value).map(([key, item]) => [key, String(item)]),
      ).toString();
      headers["Content-Type"] ??= "application/x-www-form-urlencoded";
    }
  }
  return {
    method,
    url: url.href,
    headers,
    body,
    bodyType,
    includeCookies: true,
  };
}

function xpathSearchRequest(rule: Rule, keyword: string): PreparedRequest {
  const url = String(rule.searchURL).replaceAll(
    "@keyword",
    encodeURIComponent(keyword),
  );
  if (!rule.usePost)
    return {
      method: "GET",
      url,
      headers: {},
      bodyType: "none",
      includeCookies: true,
    };
  const parsed = new URL(url);
  const body = parsed.searchParams.toString();
  parsed.search = "";
  return {
    method: "POST",
    url: parsed.href,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    bodyType: "form",
    includeCookies: true,
  };
}
function nestedKeys(value: any): string[] {
  return value && typeof value === "object"
    ? Array.isArray(value)
      ? value.flatMap(nestedKeys)
      : [...Object.keys(value), ...Object.values(value).flatMap(nestedKeys)]
    : [];
}
export function sanitizeUrl(value: string): string {
  const url = new URL(value);
  for (const key of [...url.searchParams.keys()])
    if (SECRET_RE.test(key)) url.searchParams.set(key, "<redacted>");
  url.username = "";
  url.password = "";
  return url.href;
}
export function sanitizedCurl(request: PreparedRequest): string {
  const quote = (value: string): string =>
    `'${value.replaceAll("'", "'\\''")}'`;
  const parts = [
    "curl",
    "-L",
    "--compressed",
    "-X",
    request.method,
    sanitizeUrl(request.url),
  ];
  for (const [key, value] of Object.entries(request.headers))
    parts.push("-H", `${key}: ${SECRET_RE.test(key) ? "<redacted>" : value}`);
  if (request.body !== undefined) {
    let body = request.body;
    try {
      const parsed =
        request.bodyType === "json"
          ? JSON.parse(body)
          : Object.fromEntries(new URLSearchParams(body));
      if (nestedKeys(parsed).some((key) => SECRET_RE.test(key)))
        body = "<redacted>";
    } catch {}
    parts.push("--data", body);
  }
  return parts.map(quote).join(" ");
}

export class HttpClient {
  cookies = new Map<string, string>();
  private rule: Rule;
  private timeout: number;
  constructor(rule: Rule, timeout: number) {
    this.rule = rule;
    this.timeout = timeout;
  }
  async fetch(request: PreparedRequest): Promise<[string, string]> {
    let current = { ...request, headers: { ...request.headers } };
    for (let redirects = 0; redirects <= 5; redirects++) {
      const headers = new Headers({
        "User-Agent": String(
          this.rule.userAgent || "Mozilla/5.0 KazumiRuleProbe/2.0",
        ),
        Accept: "text/html,application/json;q=0.9,*/*;q=0.8",
        ...current.headers,
      });
      if (this.rule.referer && !headers.has("Referer"))
        headers.set("Referer", String(this.rule.referer));
      if (current.includeCookies && this.cookies.size)
        headers.set(
          "Cookie",
          [...this.cookies].map(([key, value]) => `${key}=${value}`).join("; "),
        );
      const response = await fetch(current.url, {
        method: current.method,
        headers,
        body: current.body,
        redirect: "manual",
        signal: AbortSignal.timeout(this.timeout * 1000),
      });
      for (const cookie of response.headers.getSetCookie()) {
        const [pair] = cookie.split(";");
        const split = pair.indexOf("=");
        if (split > 0)
          this.cookies.set(pair.slice(0, split), pair.slice(split + 1));
      }
      if (
        [301, 302, 303, 307, 308].includes(response.status) &&
        response.headers.get("location")
      ) {
        current.url = new URL(
          response.headers.get("location")!,
          current.url,
        ).href;
        if (
          [301, 302, 303].includes(response.status) &&
          current.method === "POST"
        ) {
          current.method = "GET";
          current.body = undefined;
        }
        continue;
      }
      if (!response.ok)
        throw new ProbeError(`HTTP ${response.status} for ${current.url}`);
      return [await response.text(), response.url];
    }
    throw new ProbeError(`too many redirects for ${request.url}`);
  }
}

function rawLink(node: HtmlNode): string {
  for (const item of [node, ...node.descendants()])
    for (const key of ["href", "src", "data-src"])
      if (item.attrs[key]) return item.attrs[key];
  return "";
}
function fullLink(node: HtmlNode, base: string): string {
  const raw = rawLink(node);
  return raw ? normalizeUrl(base, raw) : "";
}
type Item = { name: string; source: string };
type Episode = { name: string; url: string };
type Road = { name: string; episodes: Episode[] };
function parseSearch(
  raw: string,
  mode: string,
  rule: Rule,
  base: string,
): [Item[], string[]] {
  const items: Item[] = [],
    diagnostics: string[] = [];
  if (mode === "api") {
    let doc;
    try {
      doc = JSON.parse(raw);
    } catch (error) {
      throw new ProbeError(`API search response is not JSON: ${String(error)}`);
    }
    const config = rule.searchApiConfig;
    jsonpathRead(doc, config.listPath).forEach((node, index) => {
      const name = first(node, config.namePath),
        source = first(node, config.sourcePath);
      if (
        name == null ||
        source == null ||
        !String(name).trim() ||
        !String(source).trim()
      )
        diagnostics.push(
          `search node ${index} lacks name or source and was skipped`,
        );
      else
        items.push({
          name: String(name).trim(),
          source: String(source).trim(),
        });
    });
  } else
    evaluateXpath(parseHtml(raw), rule.searchList).forEach((node, index) => {
      const name = evaluateXpath(node, rule.searchName)[0]?.text() ?? "";
      const sourceNode = evaluateXpath(node, rule.searchResult)[0];
      const source = sourceNode ? rawLink(sourceNode) : "";
      if (!name || !source)
        diagnostics.push(
          `search node ${index} lacks name or source and was skipped`,
        );
      else items.push({ name, source });
    });
  return [items, diagnostics];
}

function episodeUrl(
  config: Rule,
  variables: Rule,
  raw: string,
  roadIndex: number,
  episodeIndex: number,
  base: string,
): string {
  if (!config.episodePage) return normalizeUrl(base, raw);
  const values = {
    ...variables,
    episodeUrl: raw,
    roadIndex,
    roadNumber: roadIndex + 1,
    episodeIndex,
    episodeNumber: episodeIndex + 1,
  };
  const url = new URL(renderValue(config.episodePage.url, values, true), base);
  for (const [key, value] of Object.entries(
    renderValue(config.episodePage.query ?? {}, values),
  ))
    url.searchParams.set(key, String(value));
  return normalizeUrl(base, url.href);
}
export function parseChapters(
  raw: string,
  mode: string,
  rule: Rule,
  source: string,
  base: string,
): [Road[], string[]] {
  const roads: Road[] = [],
    diagnostics: string[] = [];
  if (mode === "xpath") {
    evaluateXpath(parseHtml(raw), rule.chapterRoads).forEach((road, ri) => {
      const episodes: Episode[] = [];
      evaluateXpath(road, rule.chapterResult).forEach((node, ei) => {
        const url = fullLink(node, base);
        if (!url)
          diagnostics.push(
            `road ${ri} episode ${ei} lacks URL and was skipped`,
          );
        else episodes.push({ name: node.text() || `第${ei + 1}集`, url });
      });
      if (episodes.length)
        roads.push({ name: `播放线路${roads.length + 1}`, episodes });
      else diagnostics.push(`road ${ri} has no valid episodes and was skipped`);
    });
    return [roads, diagnostics];
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (error) {
    throw new ProbeError(`API chapter response is not JSON: ${String(error)}`);
  }
  const config = rule.chapterApiConfig;
  const variables: Rule = { source };
  for (const [name, path] of Object.entries(config.variables ?? {})) {
    const value = first(doc, String(path));
    if (value == null)
      throw new ProbeError(
        `chapter response variable ${name} matched no value: ${path}`,
      );
    variables[name] = value;
  }
  if ((config.format ?? "nested") === "delimited") {
    const names = String(first(doc, config.roadNamesPath) ?? "").split(
      config.roadSeparator ?? "$$$",
    );
    String(first(doc, config.roadEpisodesPath) ?? "")
      .split(config.roadSeparator ?? "$$$")
      .forEach((group, ri) => {
        const episodes: Episode[] = [];
        group
          .split(config.episodeSeparator ?? "#")
          .forEach((entry: string, ei: number) => {
            if (!entry.trim()) return;
            const separator = config.fieldSeparator ?? "$",
              at = entry.indexOf(separator);
            if (at < 0) {
              diagnostics.push(
                `road ${ri} episode ${ei} lacks field separator and was skipped`,
              );
              return;
            }
            const url = episodeUrl(
              config,
              variables,
              entry.slice(at + separator.length).trim(),
              ri,
              ei,
              base,
            );
            if (url)
              episodes.push({
                name: entry.slice(0, at).trim() || `第${ei + 1}集`,
                url,
              });
          });
        if (episodes.length)
          roads.push({
            name: names[ri]?.trim() || `播放线路${roads.length + 1}`,
            episodes,
          });
      });
    return [roads, diagnostics];
  }
  const roadNodes = String(config.roadsPath ?? "").trim()
    ? jsonpathRead(doc, config.roadsPath)
    : [doc];
  roadNodes.forEach((road, ri) => {
    const name = config.roadNamePath ? first(road, config.roadNamePath) : null;
    const episodes: Episode[] = [];
    jsonpathRead(road, config.episodesPath).forEach((item, ei) => {
      const title = first(item, config.episodeNamePath);
      const rawUrl = config.episodeUrlPath
        ? first(item, config.episodeUrlPath)
        : "";
      const url = episodeUrl(
        config,
        variables,
        rawUrl == null ? "" : String(rawUrl),
        ri,
        ei,
        base,
      );
      if (!url)
        diagnostics.push(`road ${ri} episode ${ei} lacks URL and was skipped`);
      else
        episodes.push({
          name:
            title == null || !String(title).trim()
              ? `第${ei + 1}集`
              : String(title).trim(),
          url,
        });
    });
    if (episodes.length)
      roads.push({
        name:
          name == null || !String(name).trim()
            ? `播放线路${roads.length + 1}`
            : String(name).trim(),
        episodes,
      });
  });
  return [roads, diagnostics];
}

const MEDIA_RE =
  /https?:\\?\/\\?\/[^'"<>\s\\]+?\.(?:m3u8|mp4|flv|mpd)(?:\?[^'"<>\s\\]*)?/gi;
function mediaUrls(raw: string): string[] {
  return [
    ...new Set(
      (raw.replaceAll("\\/", "/").match(MEDIA_RE) ?? []).map((url) =>
        url.replaceAll("\\/", "/"),
      ),
    ),
  ];
}
export async function probe(rule: Rule, args: Rule): Promise<Rule> {
  const errors = validateRule(rule);
  const searchMode = ruleMode(rule, "search"),
    chapterMode = ruleMode(rule, "chapter");
  const report: Rule = {
    ok: false,
    rule: rule.name,
    keyword: args.keyword,
    searchMode,
    chapterMode,
    validationErrors: errors,
    search: {},
    playlist: {},
    parse: {},
    suggestions: [],
  };
  if (errors.length) return report;
  const client = new HttpClient(rule, args.timeout);
  const searchRequest =
    searchMode === "api"
      ? prepareApiRequest(rule.searchApiConfig.request, {
          keyword: args.keyword,
        })
      : xpathSearchRequest(rule, args.keyword);
  const [searchRaw, searchUrl] = await client.fetch(searchRequest);
  const [items, searchDiagnostics] = parseSearch(
    searchRaw,
    searchMode,
    rule,
    searchUrl,
  );
  report.search = {
    ok: !!items.length,
    url: sanitizeUrl(searchUrl),
    itemCount: items.length,
    diagnostics: searchDiagnostics,
    curl: sanitizedCurl(searchRequest),
  };
  if (!items.length) {
    report.suggestions.push("search parsing produced no valid items");
    return report;
  }
  const item = items[Math.min(args.resultIndex, items.length - 1)];
  Object.assign(report.search, {
    selectedTitle: item.name,
    selectedSource: item.source,
  });
  const chapterRequest =
    chapterMode === "api"
      ? prepareApiRequest(rule.chapterApiConfig.request, {
          source: item.source,
        })
      : {
          method: "GET",
          url: normalizeUrl(rule.baseURL, item.source),
          headers: {},
          bodyType: "none",
          includeCookies: false,
        };
  const [chapterRaw, chapterUrl] = await client.fetch(chapterRequest);
  const [roads, chapterDiagnostics] = parseChapters(
    chapterRaw,
    chapterMode,
    rule,
    item.source,
    rule.baseURL,
  );
  report.playlist = {
    ok: !!roads.length,
    url: sanitizeUrl(chapterUrl),
    roadCount: roads.length,
    roads: roads.map((road) => ({
      name: road.name,
      chapterCount: road.episodes.length,
      sampleChapters: road.episodes
        .slice(0, args.maxChapters)
        .map((episode) => ({ ...episode, url: sanitizeUrl(episode.url) })),
    })),
    diagnostics: chapterDiagnostics,
    curl: sanitizedCurl(chapterRequest),
  };
  if (!roads.length) return report;
  const episodeRequest: PreparedRequest = {
    method: "GET",
    url: roads[0].episodes[0].url,
    headers: {},
    bodyType: "none",
    includeCookies: true,
  };
  const [episodeRaw, episodeUrl] = await client.fetch(episodeRequest);
  const media = mediaUrls(episodeRaw);
  const frames = evaluateXpath(parseHtml(episodeRaw), "//iframe").map((node) =>
    fullLink(node, episodeUrl),
  );
  const iframeMedia: string[] = [];
  if (args.probeIframe)
    for (const frame of frames.slice(0, args.maxIframes))
      try {
        iframeMedia.push(
          ...mediaUrls(
            (
              await client.fetch({
                method: "GET",
                url: frame,
                headers: {},
                bodyType: "none",
                includeCookies: true,
              })
            )[0],
          ),
        );
      } catch {}
  const parseOk = !!(media.length || iframeMedia.length),
    suggestLegacy = !!(frames.length && !media.length && !rule.useLegacyParser);
  if (!parseOk)
    report.suggestions.push(
      "static probe found no media; verify the WebView resolver in Kazumi",
    );
  report.parse = {
    ok: parseOk,
    url: sanitizeUrl(episodeUrl),
    directMediaUrls: media.slice(0, args.maxMedia).map(sanitizeUrl),
    iframeUrls: frames.slice(0, args.maxIframes).map(sanitizeUrl),
    iframeMediaUrls: iframeMedia.slice(0, args.maxMedia).map(sanitizeUrl),
    ruleUsesLegacyParser: !!rule.useLegacyParser,
    suggestEnableLegacyParser: suggestLegacy,
    curl: sanitizedCurl(episodeRequest),
    note: "Static probing cannot prove Kazumi WebView playback compatibility.",
  };
  report.ok = !!(report.search.ok && report.playlist.ok && report.parse.ok);
  return report;
}

function option(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}
export async function main(argv = process.argv.slice(2)): Promise<number> {
  if (argv.includes("--help")) {
    console.log("Probe a Kazumi XPath/API rule against live endpoints.");
    return 0;
  }
  if (!argv.length) return 2;
  try {
    const args: Rule = {
      keyword:
        option(argv, "--keyword") ?? option(argv, "-k") ?? "葬送的芙莉莲",
      timeout: Number(option(argv, "--timeout") ?? 15),
      resultIndex: Number(option(argv, "--result-index") ?? 0),
      maxChapters: Number(option(argv, "--max-chapters") ?? 5),
      maxMedia: Number(option(argv, "--max-media") ?? 5),
      maxIframes: Number(option(argv, "--max-iframes") ?? 3),
      probeIframe: argv.includes("--probe-iframe"),
    };
    const report = await probe(loadRule(argv[0]), args);
    const output = JSON.stringify(report, null, 2);
    const path = option(argv, "--report-output");
    if (path) writeFileSync(path, `${output}\n`, "utf8");
    console.log(output);
    return argv.includes("--no-fail") || report.ok ? 0 : 1;
  } catch (error) {
    console.error(
      `ERROR: ${error instanceof Error ? error.message : String(error)}`,
    );
    return error instanceof RuleCodecError || error instanceof ProbeError
      ? 2
      : 2;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await main();
