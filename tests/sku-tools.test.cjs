"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const root = path.resolve(__dirname, "..");
const TARGET = "g1.2tb.ai.12months_ip_90p";
const LEGACY_TARGET = "g1.2tb.ai.annual";
const SCAN_KEY = "g1.sku.scan.v1";
const TEST_KEY = "g1.pro.annual.test.v1";
const REPORT = "https://one.google.com/g1-sku-report";
// Fixture source IDs test the matching contract; they are not store catalog evidence.
const SOURCE = "g1.ios.2tb.fixture_monthly";
const OTHER_SOURCE = "g1.ios.2tb.fixture_annual";
const TWENTY = "g1.ios.20tb.m.v2";
const THIRTY = "g1.ios.30tb.ai.pro.m";
const TWENTY_TARGET = "g1.20tb.3months_ip_90p.acq";
const THIRTY_TARGET = "g1.ai.ultra.3months_ip_90p.acq";
const TWENTY_FALLBACK = "g1.20tb.3months_ip_75p.acq";
const THIRTY_FALLBACK = "g1.ai.ultra.3months_ip_75p.acq";
const source = Object.fromEntries(
  ["g1-acq.js", "tests/fixtures/g1-acq-v6.js", "g1-sku-scan.js", "g1-sku-report.js"].map(name =>
    [name, fs.readFileSync(path.join(root, name), "utf8")])
);

function run(name, options = {}) {
  const storage = options.storage || new Map();
  const calls = [];
  const logs = [];
  const reads = [];
  const writes = [];
  const context = {
    $request: {
      url: options.url || "https://one.google.com/ai?fixture=1",
      headers: { Cookie: "cookie-secret", Authorization: "auth-secret" },
      body: typeof options.requestBody !== "undefined" ? options.requestBody : (options.isRequest ? options.body : undefined)
    },
    $response: options.isRequest ? undefined : { body: options.body, headers: { "x-private": "response-secret" } },
    $done: payload => calls.push(JSON.parse(JSON.stringify(payload))),
    console: { log: value => logs.push(String(value)) }
  };
  if (options.storageAvailable !== false) {
    context.$persistentStore = {
      read(key) {
        if (options.storageThrows) throw new Error("fixture storage failure");
        reads.push(key);
        return storage.get(key) || null;
      },
      write(value, key) {
        if (options.storageThrows) throw new Error("fixture storage failure");
        writes.push(key);
        if (options.storageWriteFails) return false;
        storage.set(key, value);
        return true;
      }
    };
  }
  vm.runInNewContext(source[name], context, { timeout: 2000, filename: name });
  assert.equal(calls.length, 1, "$done must be called once");
  return { payload: calls[0], storage, logs, reads, writes };
}

function get(storage, key) {
  return JSON.parse(storage.get(key));
}

test("combined module maps 2TB, 20TB and 30TB while preserving unrelated full tokens", () => {
  const untouched = [
    "g1.ios.12tb.fixture", TWENTY + ".extra", THIRTY + ".extra",
    "g1.ios.2tbx.fixture", "prefix" + SOURCE, "x." + SOURCE,
    "person@" + SOURCE, "g1.2tb", TARGET
  ];
  const values = [SOURCE, OTHER_SOURCE, SOURCE, TWENTY, THIRTY, ...untouched];
  const result = run("g1-acq.js", { body: JSON.stringify(values) });
  assert.deepEqual(JSON.parse(result.payload.body), [TARGET, TARGET, TARGET, TWENTY_TARGET, THIRTY_TARGET, ...untouched]);
  const record = get(result.storage, TEST_KEY);
  assert.equal(record.hitCount, 5);
  assert.equal(record.annualHitCount, 3);
  assert.equal(record.status, "rewritten");
  assert.equal(record.version, "g1-acq-v7.5");
  assert.deepEqual(record.matchedFrom, [
    { id: TWENTY, to: TWENTY_TARGET, count: 1, fallback: false },
    { id: OTHER_SOURCE, to: TARGET, count: 1, fallback: false },
    { id: SOURCE, to: TARGET, count: 2, fallback: false },
    { id: THIRTY, to: THIRTY_TARGET, count: 1, fallback: false }
  ]);
});

test("empty responses or responses with no configured sources pass through", () => {
  for (const body of ["", "g1.ios.100gb.m", "g1.ios.20tb.other", "g1.ios.30tb.other"]) {
    const result = run("g1-acq.js", { body });
    assert.deepEqual(result.payload, {});
    assert.equal(get(result.storage, TEST_KEY).status, "no-match");
  }
  for (const body of [undefined, null, 123, {}]) {
    const result = run("g1-acq.js", { body });
    assert.deepEqual(result.payload, {});
    assert.equal(get(result.storage, TEST_KEY).status, "non-text");
  }
});

test("20TB and 30TB fallback results agree with the original v6 across all offer combinations", () => {
  const offers = [TWENTY_TARGET, THIRTY_TARGET, TWENTY_FALLBACK, THIRTY_FALLBACK];
  for (let mask = 0; mask < 16; mask++) {
    const observed = offers.filter((_, index) => mask & (1 << index));
    const body = JSON.stringify([TWENTY, THIRTY, TWENTY, ...observed]);
    const legacy = run("tests/fixtures/g1-acq-v6.js", { body });
    const combined = run("g1-acq.js", { body });
    assert.equal(combined.payload.body, legacy.payload.body, "offer mask=" + mask);
    const record = get(combined.storage, TEST_KEY);
    assert.equal(record.hitCount, 3);
    assert.equal(record.annualHitCount, 0);
    assert.equal(record.status, "rewritten");
  }
});

test("fallback decisions are independent and the 2TB target stays fixed", () => {
  const body = JSON.stringify([SOURCE, TWENTY, THIRTY, TWENTY_TARGET, TWENTY_FALLBACK, THIRTY_FALLBACK]);
  const result = run("g1-acq.js", { body });
  assert.deepEqual(JSON.parse(result.payload.body).slice(0, 3), [TARGET, TWENTY_TARGET, THIRTY_FALLBACK]);
  const rows = get(result.storage, TEST_KEY).matchedFrom;
  assert.deepEqual(rows.find(row => row.id === SOURCE), { id: SOURCE, to: TARGET, count: 1, fallback: false });
  assert.deepEqual(rows.find(row => row.id === TWENTY), { id: TWENTY, to: TWENTY_TARGET, count: 1, fallback: false });
  assert.deepEqual(rows.find(row => row.id === THIRTY), { id: THIRTY, to: THIRTY_FALLBACK, count: 1, fallback: true });
});

test("single module collects other Google pages without changing the last mapping record", () => {
  for (const url of [
    "https://one.google.com/ai", "https://one.google.com/ai/other?x=1",
    "https://one.google.com/plans?x=1"
  ]) {
    const previous = JSON.stringify({ schemaVersion: 1, version: "previous-record", hitCount: 2 });
    const storage = new Map([[TEST_KEY, previous]]);
    const result = run("g1-acq.js", { url, body: SOURCE, storage });
    assert.deepEqual(result.payload, {});
    assert.equal(storage.get(TEST_KEY), previous);
    assert.equal(get(storage, SCAN_KEY).skus[0].id, SOURCE);
  }
  for (const url of [
    "https://one.google.com.evil/ai?x=1", "http://one.google.com/ai?x=1",
    REPORT, REPORT + "?format=json", REPORT + "/", REPORT + "/?format=json"
  ]) {
    const result = run("g1-acq.js", { url, body: SOURCE });
    assert.deepEqual(result.payload, {});
    assert.equal(result.storage.size, 0);
  }
});

test("single module saves original candidates before rewriting without recording generated targets", () => {
  const body = JSON.stringify([SOURCE, SOURCE, TWENTY, THIRTY, "com.google.one.fixture"]);
  const result = run("g1-acq.js", { body });
  assert.deepEqual(JSON.parse(result.payload.body), [TARGET, TARGET, TWENTY_TARGET, THIRTY_TARGET, "com.google.one.fixture"]);
  const scan = get(result.storage, SCAN_KEY);
  assert.equal(scan.version, "g1-acq-v7.5");
  assert.deepEqual(scan.skus.map(row => row.id), ["com.google.one.fixture", TWENTY, SOURCE, THIRTY]);
  assert.equal(scan.skus.find(row => row.id === SOURCE).count, 2);
  assert.deepEqual(result.writes, [SCAN_KEY, TEST_KEY]);
});

test("single-module collection decodes discovery copies and continues mapping when the list is full", () => {
  const escaped = String.raw`g1\u002eios\u002e2tb\u002eescaped`;
  const decoded = run("g1-acq.js", { body: escaped });
  assert.deepEqual(decoded.payload, {});
  assert.equal(get(decoded.storage, SCAN_KEY).skus[0].id, "g1.ios.2tb.escaped");
  const storage = new Map();
  const full = Array.from({ length: 305 }, (_, index) => "g1.fixture." + index).join(" ");
  run("g1-acq.js", { url: "https://one.google.com/plans", body: full, storage });
  const fullEvent = get(storage, SCAN_KEY).recentResponses.at(-1);
  assert.equal(fullEvent.status, "new-skus");
  assert.equal(fullEvent.candidateCount, 305);
  assert.equal(fullEvent.addedCount, 300);
  assert.equal(fullEvent.omittedCount, 5);
  const next = run("g1-acq.js", { body: SOURCE + " g1.fixture.0", storage });
  assert.equal(next.payload.body, TARGET + " g1.fixture.0");
  const scan = get(storage, SCAN_KEY);
  assert.equal(scan.skus.length, 300);
  assert.equal(scan.truncated, true);
  assert.equal(scan.scannedResponses, 2);
  assert.equal(scan.skus.find(row => row.id === "g1.fixture.0").count, 2);
  assert.equal(scan.recentResponses.at(-1).status, "limit-reached");
  assert.equal(scan.recentResponses.at(-1).candidateCount, 2);
  assert.equal(scan.recentResponses.at(-1).addedCount, 0);
  assert.equal(scan.recentResponses.at(-1).omittedCount, 1);
});

test("activity distinguishes new IDs, repeated IDs, empty text and nontext responses", () => {
  const storage = new Map();
  const url = "https://one.google.com/plans?token=private-token";
  const body = [SOURCE, SOURCE, OTHER_SOURCE].join(" ");
  run("g1-acq.js", { url, body, storage });
  let scan = get(storage, SCAN_KEY);
  assert.equal(scan.recentResponses[0].status, "new-skus");
  assert.equal(scan.recentResponses[0].candidateCount, 2);
  assert.equal(scan.recentResponses[0].addedCount, 2);
  run("g1-acq.js", { url, body, storage });
  scan = get(storage, SCAN_KEY);
  assert.equal(scan.skus.length, 2);
  assert.equal(scan.skus.find(row => row.id === SOURCE).count, 4);
  assert.equal(scan.scannedResponses, 2);
  assert.equal(scan.matchedResponses, 2);
  assert.equal(scan.recentResponses.at(-1).status, "known-skus");
  assert.equal(scan.recentResponses.at(-1).candidateCount, 2);
  assert.equal(scan.recentResponses.at(-1).addedCount, 0);
  run("g1-acq.js", { url, body: "no product in this response", storage });
  run("g1-acq.js", { url, body: undefined, storage });
  scan = get(storage, SCAN_KEY);
  assert.deepEqual(scan.recentResponses.map(event => event.status), ["new-skus", "known-skus", "no-skus", "non-text"]);
  assert.equal(scan.scannedResponses, 3);
  assert.equal(scan.matchedResponses, 2);
  assert.equal(scan.nonTextResponses, 1);
  assert.equal(scan.skus.length, 2);
  assert.equal(scan.recentResponses.at(-1).bodyType, "non-text");
  assert.equal(scan.recentResponses.at(-1).candidateCount, 0);
  assert.equal(storage.has(TEST_KEY), false, "non-rewrite pages preserve the mapping record");
  assert(!storage.get(SCAN_KEY).includes("private-token"));
  const data = JSON.parse(run("g1-sku-report.js", { url: REPORT + "?format=json", storage }).payload.response.body);
  assert.deepEqual(data.scan.recentResponses, scan.recentResponses);
  assert.equal(data.scan.nonTextResponses, 1);
  const html = run("g1-sku-report.js", { url: REPORT, storage }).payload.response.body;
  assert(html.includes("实际采集脚本：<code>g1-acq-v7.5</code>"));
  assert(html.includes("编号与已有记录重复"));
  assert(html.includes("正文不是可扫描文本"));
});

test("recent activity keeps ten arrivals and redacts URLs, extra fields and malformed events", () => {
  const valid = {
    at: "2099-01-01T00:00:00.000Z", path: "/ai", bodyType: "text", status: "no-skus",
    candidateCount: 0, addedCount: 0, omittedCount: 0, body: "private-history-body"
  };
  const storage = new Map([[SCAN_KEY, JSON.stringify({
    schemaVersion: 1, recentResponses: [valid, { ...valid, path: "/private-secret" }, { ...valid, status: "bad-status" }]
  })]]);
  run("g1-acq.js", { url: "https://one.google.com/plans?secret=1", body: SOURCE, storage });
  let scan = get(storage, SCAN_KEY);
  assert.equal(scan.recentResponses.length, 2);
  assert.equal(scan.recentResponses[0].at, valid.at);
  assert.equal(scan.recentResponses.at(-1).path, "/plans", "last received event stays last even after a clock change");
  const paths = ["/", "/ai/", "/plans/", "/_/GoogleOne/account-secret/data/batchexecute", "/account/private@example.test"];
  const expected = ["/", "/ai", "/plans", "/_/…/data/batchexecute", "[其他 one.google.com 路径]"];
  for (let index = 0; index < 14; index++) {
    run("g1-acq.js", { url: "https://one.google.com" + paths[index % 5] + "?secret=query#private-fragment", body: SOURCE, storage });
  }
  scan = get(storage, SCAN_KEY);
  assert.equal(scan.recentResponses.length, 10);
  assert.deepEqual(scan.recentResponses.map(event => event.path), Array.from({ length: 10 }, (_, index) => expected[(index + 4) % 5]));
  assert(scan.recentResponses.every(event => event.status === "known-skus" && event.addedCount === 0));
  for (const forbidden of ["private-history-body", "private-secret", "account-secret", "private@example.test", "query", "private-fragment", "secret="]) {
    assert(!storage.get(SCAN_KEY).includes(forbidden));
  }
});

test("old scan records remain old until an actual response creates a new diagnostic event", () => {
  const old = {
    schemaVersion: 1, version: "g1-acq-v7.1", updatedAt: "2026-11-23T07:40:18.464Z",
    scannedResponses: 5, matchedResponses: 1,
    skus: [{ id: SOURCE, count: 4, lastSeen: "2026-11-23T07:40:06.325Z" }]
  };
  const storage = new Map([[SCAN_KEY, JSON.stringify(old)]]);
  const before = storage.get(SCAN_KEY);
  let data = JSON.parse(run("g1-sku-report.js", { url: REPORT + "?format=json", storage }).payload.response.body);
  assert.equal(data.scan.version, "g1-acq-v7.1");
  assert.deepEqual(data.scan.recentResponses, []);
  assert.equal(data.scan.scannedResponses, 5);
  assert.equal(storage.get(SCAN_KEY), before);
  const html = run("g1-sku-report.js", { url: REPORT, storage }).payload.response.body;
  assert(html.includes("旧采集记录；尚未保存本版采集响应记录"));
  run("g1-acq.js", { url: "https://one.google.com/plans", body: SOURCE, storage });
  data = JSON.parse(run("g1-sku-report.js", { url: REPORT + "?format=json", storage }).payload.response.body);
  assert.equal(data.scan.version, "g1-acq-v7.5");
  assert.equal(data.scan.scannedResponses, 6);
  assert.equal(data.scan.matchedResponses, 2);
  assert.equal(data.scan.skus.length, 1);
  assert.equal(data.scan.skus[0].count, 5);
  assert.equal(data.scan.recentResponses.length, 1);
  assert.equal(data.scan.recentResponses[0].status, "known-skus");
  assert.equal(data.scan.recentResponses[0].addedCount, 0);
});

test("activity export rejects malformed metadata and excludes untrusted extra fields", () => {
  const event = {
    at: "2026-11-23T07:40:06.325Z", path: "/plans", bodyType: "text", status: "known-skus",
    candidateCount: 2, addedCount: 0, omittedCount: 0, body: "private-body", query: "private-token"
  };
  const storage = new Map([[SCAN_KEY, JSON.stringify({
    schemaVersion: 1, version: "g1-acq-v7.5",
    recentResponses: [event, { ...event, at: "<script>private</script>" }, { ...event, status: "constructor" }, { ...event, bodyType: "unknown" }]
  })]]);
  const result = run("g1-sku-report.js", { url: REPORT + "?format=json", storage });
  const data = JSON.parse(result.payload.response.body);
  assert.deepEqual(data.scan.recentResponses, [{
    at: event.at, path: event.path, bodyType: "text", status: "known-skus", candidateCount: 2, addedCount: 0, omittedCount: 0
  }]);
  assert(!result.payload.response.body.includes("private"));
});

test("storage errors do not prevent a matched response from completing", () => {
  for (const flags of [{ storageAvailable: false }, { storageThrows: true }, { storageWriteFails: true }]) {
    const result = run("g1-acq.js", { body: SOURCE, ...flags });
    assert.equal(result.payload.body, TARGET);
  }
});

test("test records omit cookies, headers and full response data", () => {
  const result = run("g1-acq.js", { body: JSON.stringify({ sku: SOURCE, email: "private@example.test" }) });
  const saved = result.storage.get(TEST_KEY);
  assert(!saved.includes("private@example.test"));
  assert(!saved.includes("secret"));
  assert.deepEqual(result.reads, [SCAN_KEY]);
  assert(!result.storage.get(SCAN_KEY).includes("private@example.test"));
  assert(!result.storage.get(SCAN_KEY).includes("secret"));
});

test("collector discovers IDs and escaped dots while preserving the response", () => {
  const body = JSON.stringify([
    SOURCE, SOURCE, TARGET, "com.google.one.2tb.fixture.iog", "private@example.test"
  ]) + String.raw` "g1\u002eios\u002e2tb\u002eescaped" "g1&#46;2tb&#46;html"`;
  const result = run("g1-sku-scan.js", { body });
  assert.deepEqual(result.payload, {});
  const state = get(result.storage, SCAN_KEY);
  assert.equal(state.scannedResponses, 1);
  assert.equal(state.matchedResponses, 1);
  assert.equal(state.skus.length, 5);
  assert.equal(state.skus.find(row => row.id === SOURCE).count, 2);
  assert(state.skus.some(row => row.id === "g1.ios.2tb.escaped"));
  assert(state.skus.some(row => row.id === "g1.2tb.html"));
  assert(!JSON.stringify(state).includes("private@example.test"));
  assert(!JSON.stringify(state).includes("secret"));
});

test("collector accumulates prior records and recovers corrupt storage", () => {
  const storage = new Map([[SCAN_KEY, "corrupt JSON"]]);
  run("g1-sku-scan.js", { body: SOURCE, storage });
  run("g1-sku-scan.js", { url: "https://one.google.com/plans", body: SOURCE + " " + TARGET, storage });
  const state = get(storage, SCAN_KEY);
  assert.equal(state.scannedResponses, 2);
  assert.equal(state.skus.length, 2);
  assert.equal(state.skus.find(row => row.id === SOURCE).count, 2);
});

test("collector bounds stored candidates at 300 and still counts existing IDs", () => {
  const body = Array.from({ length: 305 }, (_, index) => "g1.fixture." + index).join(" ");
  const result = run("g1-sku-scan.js", { body });
  assert.equal(get(result.storage, SCAN_KEY).skus.length, 300);
  assert.equal(get(result.storage, SCAN_KEY).truncated, true);
  run("g1-sku-scan.js", { body: "g1.fixture.0", storage: result.storage });
  assert.equal(get(result.storage, SCAN_KEY).skus.find(row => row.id === "g1.fixture.0").count, 2);
});

test("collector skips the local report, other domains and nontext bodies", () => {
  for (const options of [
    { url: REPORT, body: SOURCE },
    { url: REPORT + "?format=json", body: SOURCE },
    { url: REPORT + "/", body: SOURCE },
    { url: REPORT + "/?format=json", body: SOURCE },
    { url: "https://one.google.com.evil/ai?x=1", body: SOURCE },
    { body: undefined }, { body: new Uint8Array([1, 2]) }
  ]) {
    const result = run("g1-sku-scan.js", options);
    assert.deepEqual(result.payload, {});
    assert.equal(result.storage.size, 0);
  }
});

test("collector passes through on storage failure", () => {
  const result = run("g1-sku-scan.js", { body: SOURCE, storageThrows: true });
  assert.deepEqual(result.payload, {});
  assert(result.logs.some(line => line.includes("saved=no")));
});

test("report displays captured IDs and test sources without external assets", () => {
  const storage = new Map();
  run("g1-sku-scan.js", { body: SOURCE, storage });
  run("g1-acq.js", { body: SOURCE, storage });
  const { payload } = run("g1-sku-report.js", { url: REPORT, storage });
  assert.equal(payload.response.status, 200);
  assert.match(payload.response.body, /Google One SKU 本地报告/);
  assert(payload.response.body.includes(SOURCE));
  assert(payload.response.body.includes(TARGET));
  assert(payload.response.body.includes("本机脚本已接管 · v7.5.0"));
  assert.match(payload.response.body, /<button\b[^>]*name=format[^>]*value=json[^>]*>导出 JSON<\/button>/);
  assert(!/<(?:script|img|iframe)\b/i.test(payload.response.body));
  assert.equal(payload.response.headers["Cache-Control"], "no-store");
});

test("report export form resolves to a JSON attachment and supports a trailing slash", () => {
  const storage = new Map();
  run("g1-acq.js", { body: SOURCE, storage });
  const html = run("g1-sku-report.js", { url: REPORT + "/", storage }).payload.response.body;
  const action = html.match(/<form method=get action="([^"]+)"><button type=submit name=format value=json>/);
  assert(action, "the visible export button must submit a GET form");
  const url = new URL(action[1]);
  url.searchParams.set("format", "json");
  assert.equal(url.href, REPORT + "?format=json");
  for (const exportURL of [url.href, REPORT + "/?format=json"]) {
    const result = run("g1-sku-report.js", { url: exportURL, storage });
    assert.equal(result.payload.response.status, 200);
    assert.equal(result.payload.response.headers["Content-Disposition"], 'attachment; filename="g1-sku-report.json"');
    assert.equal(result.payload.response.headers["X-G1-Report-Version"], "v7.5.0");
    const data = JSON.parse(result.payload.response.body);
    assert.equal(data.reportVersion, "v7.5.0");
    assert.equal(data.configuredTarget, TARGET);
    assert.equal(data.test.target, TARGET);
    assert.equal(data.test.targetOrigin, "user-specified");
    assert.equal(data.scan.skus[0].id, SOURCE);
    assert.equal(data.test.matchedFrom[0].to, TARGET);
    assert(result.logs.some(line => line.includes("[g1-sku-report] v7.5.0 json")));
  }
});

test("report exports each actual target and separates annual hits from total hits", () => {
  const storage = new Map();
  run("g1-acq.js", {
    body: JSON.stringify([SOURCE, TWENTY, THIRTY, THIRTY_FALLBACK]), storage
  });
  const result = run("g1-sku-report.js", { url: REPORT + "?format=json", storage });
  const data = JSON.parse(result.payload.response.body).test;
  assert.equal(data.version, "g1-acq-v7.5");
  assert.equal(data.hitCount, 3);
  assert.equal(data.annualHitCount, 1);
  assert.equal(data.matchedFrom.find(row => row.id === TWENTY).to, TWENTY_TARGET);
  assert.deepEqual(data.matchedFrom.find(row => row.id === THIRTY), {
    id: THIRTY, count: 1, to: THIRTY_FALLBACK, fallback: true
  });
  const html = run("g1-sku-report.js", { url: REPORT, storage }).payload.response.body;
  assert(html.includes("最近一次三档映射"));
  assert(html.includes("其中 2TB：1"));
  assert(html.includes(TWENTY_TARGET));
  assert(html.includes(THIRTY_FALLBACK));
});

test("new report displays existing v1 records with their original 2TB target", () => {
  const storage = new Map([[TEST_KEY, JSON.stringify({
    schemaVersion: 1, version: "pro-annual-test-v1", hitCount: 2, status: "rewritten",
    matchedFrom: [{ id: SOURCE, count: 2 }]
  })]]);
  const result = run("g1-sku-report.js", { url: REPORT + "?format=json", storage });
  const data = JSON.parse(result.payload.response.body).test;
  assert.equal(data.version, "pro-annual-test-v1");
  assert.equal(data.hitCount, 2);
  assert.equal(data.annualHitCount, 2);
  assert.equal(data.target, LEGACY_TARGET);
  assert.equal(data.targetOrigin, "legacy");
  assert.deepEqual(data.matchedFrom, [{ id: SOURCE, count: 2, to: LEGACY_TARGET, fallback: false }]);
  storage.set(TEST_KEY, JSON.stringify({
    schemaVersion: 1, version: "pro-annual-test-v1", hitCount: 0,
    status: "no-match", matchedFrom: []
  }));
  const html = run("g1-sku-report.js", { url: REPORT, storage }).payload.response.body;
  assert(html.includes("旧 v1 记录：本次响应未命中 iOS 2TB 前缀"));
});

test("report preserves saved v7.1 through v7.4 targets and origins independently of current configuration", () => {
  for (const prior of [
    { version: "g1-acq-v7.1", target: LEGACY_TARGET, origin: "legacy" },
    { version: "g1-acq-v7.2", target: "g1.2tb.ai.annual.3months_ip_90p.acq", origin: "pattern-derived" },
    { version: "g1-acq-v7.3", target: "g1.2tb.ai.annual_ip_90p.acq", origin: "user-specified" },
    { version: "g1-acq-v7.4", target: "g1.2tb.ai.annual_ip_90p.acq", origin: "user-specified" }
  ]) {
    const record = {
      schemaVersion: 1, version: prior.version, target: prior.target,
      status: "rewritten", hitCount: 9, annualHitCount: 9,
      matchedFrom: [{ id: "g1.ios.2tb.ai.a", to: prior.target, count: 9, fallback: false }]
    };
    if (prior.origin !== "legacy") record.targetOrigin = prior.origin;
    const storage = new Map([[TEST_KEY, JSON.stringify(record)]]);
    const before = storage.get(TEST_KEY);
    const data = JSON.parse(run("g1-sku-report.js", { url: REPORT + "?format=json", storage }).payload.response.body);
    assert.equal(data.configuredTarget, TARGET);
    assert.equal(data.test.version, prior.version);
    assert.equal(data.test.target, prior.target);
    assert.equal(data.test.targetOrigin, prior.origin);
    assert.equal(data.test.matchedFrom[0].to, prior.target);
    assert.equal(storage.get(TEST_KEY), before);
    const html = run("g1-sku-report.js", { url: REPORT, storage }).payload.response.body;
    assert(html.includes("当前配置的 2TB 候选目标：<code>" + TARGET + "</code>"));
    assert(html.includes("该次记录的 2TB 目标：<code>" + prior.target + "</code>"));
  }
  const empty = JSON.parse(run("g1-sku-report.js", { url: REPORT + "?format=json" }).payload.response.body);
  assert.equal(empty.configuredTarget, TARGET);
  assert.equal(empty.test.target, "");
  assert.equal(empty.test.targetOrigin, "");
  assert.equal(empty.test.status, "");
});

test("JSON export is limited to report fields and escapes untrusted HTML text", () => {
  const storage = new Map([[SCAN_KEY, JSON.stringify({
    schemaVersion: 1, updatedAt: "<script>fixture</script>", scannedResponses: 1,
    secret: "must-not-export", body: "must-not-export",
    skus: [{ id: SOURCE, count: 2, lastSeen: "<img src=x>", secret: "must-not-export" }]
  })]]);
  const jsonResult = run("g1-sku-report.js", { url: REPORT + "?format=json", storage });
  assert.match(jsonResult.payload.response.headers["Content-Type"], /application\/json/);
  const report = JSON.parse(jsonResult.payload.response.body);
  assert.equal(report.scan.skus[0].id, SOURCE);
  assert(!jsonResult.payload.response.body.includes("must-not-export"));
  const htmlResult = run("g1-sku-report.js", { url: REPORT, storage });
  assert(!htmlResult.payload.response.body.includes("<script>fixture"));
  assert(htmlResult.payload.response.body.includes("&lt;img src=x&gt;"));
});

test("clear action affects only the tool's two storage keys", () => {
  const storage = new Map([
    [SCAN_KEY, JSON.stringify({ schemaVersion: 1, skus: [{ id: SOURCE, count: 1 }] })],
    [TEST_KEY, JSON.stringify({ schemaVersion: 1, hitCount: 1 })],
    ["other-tool", "untouched"]
  ]);
  const result = run("g1-sku-report.js", { url: REPORT + "?clear=1", storage });
  assert.deepEqual(get(storage, SCAN_KEY), {});
  assert.deepEqual(get(storage, TEST_KEY), {});
  assert.equal(storage.get("other-tool"), "untouched");
  assert.deepEqual(new Set(result.reads), new Set([SCAN_KEY, TEST_KEY]));
});

test("report handles unavailable storage and skips other URL paths", () => {
  const unavailable = run("g1-sku-report.js", { url: REPORT + "?format=json", storageAvailable: false });
  assert.equal(JSON.parse(unavailable.payload.response.body).storageAvailable, false);
  for (const url of ["https://one.google.com/ai?x=1", REPORT + "-other", "https://example.test/g1-sku-report"]) {
    const result = run("g1-sku-report.js", { url });
    assert.deepEqual(result.payload, {});
    assert.deepEqual(result.reads, []);
  }
});

test("the new installer replaces the old entry and all modules share one fixed release", () => {
  assert.equal(fs.existsSync(path.join(root, "g1-acq.sgmodule")), false);
  let scriptBase;
  for (const file of ["g1-acq-v7.sgmodule", "g1-pro-annual-test.sgmodule", "g1-sku-scan.sgmodule"]) {
    const module = fs.readFileSync(path.join(root, file), "utf8");
    const scripts = module.split("\n").filter(line => line.includes("script-path="));
    assert.equal(scripts.length, file === "g1-sku-scan.sgmodule" ? 2 : 3);
    if (file === "g1-acq-v7.sgmodule") assert.match(module, /^#!name=G1 ACQ$/m);
    for (const script of scripts) {
      const url = script.match(/script-path=([^,\s]+)/)[1];
      assert.match(url, /^https:\/\/cdn\.jsdelivr\.net\/gh\/crhywun\/g1-acq@v7\.5\.0\/[a-z0-9.-]+\.js$/);
      const base = url.slice(0, url.lastIndexOf("/") + 1);
      if (!scriptBase) scriptBase = base;
      assert.equal(base, scriptBase);
      assert(fs.existsSync(path.join(root, url.split("/").at(-1))));
    }
    assert.match(module, /hostname = %APPEND% one\.google\.com/);
    const responseLine = scripts.find(line => line.includes("type=http-response"));
    const pattern = new RegExp(responseLine.match(/pattern=([^,]+)/)[1]);
    assert(pattern.test("https://one.google.com/ai?x=1"));
    assert(!pattern.test("https://one.google.com.evil/ai?x=1"));
    assert.equal(pattern.test("https://one.google.com/plans"), file !== "g1-pro-annual-test.sgmodule");
    assert.equal(pattern.test("https://one.google.com/ai"), file !== "g1-pro-annual-test.sgmodule");
    if (file !== "g1-sku-scan.sgmodule") {
      assert.equal(responseLine.match(/script-path=([^,\s]+)/)[1],
        scriptBase + "g1-acq.js");
      const reqLine = scripts.find(line => line.includes("type=http-request") && line.includes("g1-acq.js"));
      assert(reqLine);
      assert.match(reqLine, /requires-body=1/);
    }
    const reportLine = scripts.find(line => line.includes("g1-sku-report.js"));
    assert.equal(reportLine.match(/script-path=([^,\s]+)/)[1],
      scriptBase + "g1-sku-report.js");
    const reportPattern = new RegExp(reportLine.match(/pattern=([^,]+)/)[1]);
    for (const url of [REPORT, REPORT + "?format=json", REPORT + "/", REPORT + "/?format=json"]) {
      assert(reportPattern.test(url));
    }
    for (const url of [REPORT + "-other", REPORT + "/other", "https://one.google.com.evil/g1-sku-report"]) {
      assert(!reportPattern.test(url));
    }
  }
});

test("request body with g1.ios.20tb.m.v2 is rewritten to g1.ai.ultra.1month_eft.acq", () => {
  const targetSku = "g1.ai.ultra.1month_eft.acq";
  // JSON string payload
  const jsonBody = JSON.stringify({ item: TWENTY, count: 1 });
  const res1 = run("g1-acq.js", { isRequest: true, body: jsonBody });
  assert.equal(res1.payload.body, JSON.stringify({ item: targetSku, count: 1 }));

  // Raw text payload
  const textBody = "order=" + TWENTY + "&tier=20tb";
  const res2 = run("g1-acq.js", { isRequest: true, body: textBody });
  assert.equal(res2.payload.body, "order=" + targetSku + "&tier=20tb");

  // URL-encoded dot notation
  const urlEncoded = "f.req=%5B%22g1%2Eios%2E20tb%2Em%2Ev2%22%5D";
  const res3 = run("g1-acq.js", { isRequest: true, body: urlEncoded });
  assert.equal(res3.payload.body, "f.req=%5B%22" + targetSku + "%22%5D");

  // Object payload
  const objBody = { sku: TWENTY, active: true };
  const res4 = run("g1-acq.js", { isRequest: true, requestBody: objBody });
  assert.deepEqual(res4.payload.body, { sku: targetSku, active: true });

  // Unrelated payload passes through untouched
  const untouched = JSON.stringify({ item: "g1.ios.2tb.monthly" });
  const res5 = run("g1-acq.js", { isRequest: true, body: untouched });
  assert.deepEqual(res5.payload, {});

  // URL outside one.google.com passes through
  const res6 = run("g1-acq.js", {
    isRequest: true,
    url: "https://other.google.com/checkout",
    body: jsonBody
  });
  assert.deepEqual(res6.payload, {});

  // g1-sku-report URL passes through
  const res7 = run("g1-acq.js", {
    isRequest: true,
    url: "https://one.google.com/g1-sku-report",
    body: jsonBody
  });
  assert.deepEqual(res7.payload, {});
});
