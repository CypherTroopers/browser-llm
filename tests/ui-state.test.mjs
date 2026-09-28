// Application event-flow tests with an in-memory DOM and the actual Worker dispatcher.
// This is NOT a rendered browser test, real GPU test, or a real model download.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRuntime } from "../public/worker.js";
import { MODELS, PROFILE_KEY, ATTEMPT_KEY, errorDetails } from "../public/models.js";

class Element {
  constructor(tag = "div") { this.tagName = tag.toUpperCase(); this.children = []; this._text = ""; this.value = ""; this.disabled = false; this.open = false; this.style = { setProperty() {} }; }
  get textContent() { return this._text + this.children.map(child => typeof child === "string" ? child : child.textContent).join(""); }
  set textContent(text) { this._text = String(text); this.children = []; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this._text = ""; this.children = children; }
  addEventListener() {}
  scrollIntoView() {}
  setAttribute(name, value) { this[name] = value; }
  blur() {}
}
class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(key) { return this.map.get(key) ?? null; }
  setItem(key, value) { this.map.set(key, String(value)); }
  removeItem(key) { this.map.delete(key); }
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function environment() {
  const ids = [...readFileSync(new URL("../public/index.html", import.meta.url), "utf8").matchAll(/id="([^"]+)"/g)].map(match => match[1]);
  const elements = Object.fromEntries(ids.map(id => [id, new Element()]));
  elements.mode.value = "auto"; elements.cap.value = "1200"; elements.answerLanguage.value = "en";
  elements.start.disabled = true; elements.send.disabled = true; elements.timeRange.value = "";
  const listeners = {};
  const state = { consent: false, calls: [], loadFail: false, searchFail: false, reasoningOnly: false, reloads: 0, workers: [] };
  const localStorage = new MemoryStorage(), sessionStorage = new MemoryStorage();
  const window = {
    localStorage, isSecureContext: true, innerHeight: 844,
    addEventListener(name, callback) { (listeners[name] ||= []).push(callback); },
    confirm() { return state.consent; },
  };
  const records = MODELS.flatMap((model, i) => model.variants.map(model_id => ({ model_id,
    model: `https://huggingface.co/mock/${model.key}`, model_lib: "mock.wasm",
    vram_required_MB: 500 + i * 10, overrides: { context_window_size: 4096 },
  })));
  class FakeEngine {
    constructor(options) { this.options = options; this.chat = { completions: { create: request => this.create(request) } }; }
    async reload(modelId) {
      state.calls.push({ kind: "load", modelId }); this.id = modelId;
      if (state.loadFail) { state.loadFail = false; throw Object.assign(new Error("Synthetic device loss"), { name: "DeviceLostError" }); }
      this.options.initProgressCallback({ text: "Loaded mock", progress: 1 });
    }
    async unload() { state.calls.push({ kind: "unload" }); }
    async resetChat() {}
    async create(request) {
      state.calls.push({ kind: "generate", modelId: this.id, request });
      if (!request.stream) return { usage: { completion_tokens: request.max_tokens } };
      const text = this.id.startsWith("DeepSeek") ? state.reasoningOnly ? "<think>Unfinished draft" : "<think>Draft</think>Answer [1]." : "Answer [1].";
      return (async function* () {
        yield { choices: [{ delta: { content: text }, finish_reason: state.reasoningOnly ? "length" : "stop" }] };
        yield { choices: [], usage: { completion_tokens: request.max_tokens, prompt_tokens: 100, extra: { decode_tokens_per_s: 20 } } };
      })();
    }
  }
  class MockWorker {
    constructor() {
      this.dead = false; let clock = 0;
      this.runtime = createRuntime({
        loadLibrary: async () => ({ prebuiltAppConfig: { model_list: records }, MLCEngine: FakeEngine, hasModelInCache: async () => false }),
        readDevice: async () => ({ features: ["shader-f16"], maxBufferSize: 1e9, maxStorageBufferBindingSize: 1e9 }),
        fetcher: async () => ({ ok: true, text: async () => JSON.stringify({ records: [{ dataPath: "shard", nbytes: 1000 }] }) }),
        estimate: async () => ({ usage: 0, quota: 1e9 }), now: () => (clock += 100),
      });
      state.workers.push(this);
    }
    postMessage({ id, type, data }) {
      queueMicrotask(async () => {
        const send = (kind, value) => { if (!this.dead) this.onmessage?.({ data: { id, kind, value } }); };
        if (this.dead) return;
        try { send("result", await this.runtime.dispatch(type, data, send)); }
        catch (error) { send("error", errorDetails(error, type)); }
      });
    }
    terminate() { this.dead = true; }
  }
  Object.assign(globalThis, { window, sessionStorage,
    document: { getElementById: id => elements[id], createElement: tag => new Element(tag), documentElement: new Element("html") },
    location: { reload: () => state.reloads++ },
    requestAnimationFrame: callback => setTimeout(callback, 0),
    Option: class extends Element { constructor(text, value) { super("option"); this.textContent = text; this.value = value; } },
    Worker: MockWorker,
    fetch: async (url, options) => {
      state.calls.push({ kind: "search", body: JSON.parse(options.body) });
      if (state.searchFail) return { ok: false, status: 502, json: async () => ({ ok: false, error: "Synthetic search error" }) };
      return { ok: true, json: async () => ({ ok: true, retrieved_at: "2026-09-28T00:00:00Z", results: [
        { title: "Source", domain: "example.com", url: "https://example.com/test", snippet: "Synthetic test evidence.", published: "" },
      ] }) };
    },
  });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { userAgent: "test-browser", deviceMemory: 8 } });
  return { state, elements, localStorage, sessionStorage, listeners };
}

test("UI event flow using an in-memory DOM and mocked inference", async t => {
  const { state, elements: el, localStorage, listeners } = environment();
  await import(`../public/app.js?ui-test=${Date.now()}`);
  for (let i = 0; i < 20 && el.start.disabled; i++) await tick();
  const loads = () => state.calls.filter(call => call.kind === "load");
  const generations = () => state.calls.filter(call => call.kind === "generate");
  const send = async text => { el.prompt.value = text; await el.form.onsubmit({ preventDefault() {} }); };

  await t.test("initialization enables Start but does not load model weights", () => {
    assert.equal(el.start.disabled, false);
    assert.equal(loads().length, 0);
    assert.match(el.device.textContent, /26\/26/);
  });
  await t.test("cancel initial selection leaves no model loaded", async () => {
    await el.start.onclick();
    assert.equal(loads().length, 0);
    assert.equal(el.send.disabled, true);
    assert.match(el.status.textContent, /Cancelled/);
  });
  await t.test("Start loads exactly one model and runs the complete benchmark", async () => {
    state.consent = true;
    await el.start.onclick();
    assert.equal(el.send.disabled, false);
    assert.equal(loads().length, 1);
    assert.deepEqual(generations().map(call => call.request.max_tokens), [8, 64, 64]);
  });
  await t.test("search, streamed answer, and citation UI retain their event flow", async () => {
    await send("Explain browser inference");
    assert.match(el.chat.textContent, /Answer \[1\]/);
    assert.ok(state.calls.some(call => call.kind === "search"));
    assert.match(el.status.textContent, /Answer complete/);
  });
  await t.test("cancelling replacement keeps current chat and loaded model", async () => {
    state.consent = false;
    const old = el.chat.textContent;
    await el.start.onclick();
    assert.equal(el.chat.textContent, old);
    assert.equal(loads().length, 1);
    assert.equal(el.send.disabled, false);
  });
  await t.test("benchmark profile is local and successful conversation is recorded", () => {
    const profile = JSON.parse(localStorage.getItem(PROFILE_KEY));
    assert.equal(profile.results.length, 1);
    assert.equal(profile.results[0].chatSucceeded, true);
    assert.ok(!("messages" in profile.results[0]));
  });
  await t.test("manual reasoning model has separate output settings and final-answer handling", async () => {
    state.consent = true;
    el.mode.value = MODELS.find(model => model.key.startsWith("DeepSeek")).variants[0];
    el.mode.onchange();
    await el.start.onclick();
    await send("Explain the evidence");
    assert.match(el.chat.textContent, /Model-generated reasoning/);
    assert.equal(generations().at(-1).request.max_tokens, 1024);
    assert.equal(generations().at(-1).request.messages[0].role, "user");
  });
  await t.test("reasoning-only output is not mistaken for final answer or GPU failure", async () => {
    state.reasoningOnly = true;
    await send("Another question");
    assert.match(el.status.textContent, /No final answer/);
    assert.equal(el.send.disabled, false);
    state.reasoningOnly = false;
  });
  await t.test("search failure does not generate an offline answer", async () => {
    const count = generations().length;
    state.searchFail = true;
    await send("Fail the search");
    assert.match(el.status.textContent, /Search failed/);
    assert.equal(generations().length, count);
    assert.equal(el.send.disabled, false);
    state.searchFail = false;
  });
  await t.test("GPU failure does not start additional hidden model loads", async () => {
    el.mode.value = "auto";
    state.loadFail = true;
    const count = loads().length;
    await el.start.onclick();
    assert.equal(loads().length, count + 1);
    assert.match(el.status.textContent, /Startup failed \[GPU\]/);
    assert.equal(el.send.disabled, true);
    assert.equal(el.start.disabled, false);
  });
  await t.test("Forget measurements clears performance data but not caches", () => {
    const count = state.calls.length;
    el.forgetProfile.onclick();
    assert.deepEqual(JSON.parse(localStorage.getItem(PROFILE_KEY)).results, []);
    assert.equal(state.calls.length, count);
  });
  await t.test("BFCache recovery does not force a page reload", async () => {
    await el.start.onclick();
    for (const handler of listeners.pagehide) handler({ persisted: true });
    for (const handler of listeners.pageshow) await handler({ persisted: true });
    assert.equal(el.send.disabled, false);
    assert.equal(state.reloads, 0);
  });
  for (const worker of state.workers) worker.terminate();
  await tick();
});
