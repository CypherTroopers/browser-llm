// Inference stays in this browser Worker. No search requests originate here.
const LIBRARY = "https://esm.run/@mlc-ai/web-llm@0.2.85";
let engine;
let busy = false;

self.onmessage = async ({ data: { id, type, data } }) => {
  const send = (kind, value) => self.postMessage({ id, kind, value });
  if (busy) return send("error", "Another task is already running.");
  busy = true;
  try {
    if (type === "load") {
      if (!["0.5B", "1.5B", "3B"].includes(data.size)) {
        throw new Error("This model is not allowed.");
      }
      if (!self.isSecureContext || !navigator.gpu) {
        throw new Error("WebGPU is not available in this Worker.");
      }
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) throw new Error("Unable to obtain a WebGPU adapter.");
      const quant = adapter.features.has("shader-f16") ? "q4f16_1" : "q4f32_1";
      const model = `Qwen2.5-${data.size}-Instruct-${quant}-MLC`;
      send("progress", { progress: 0, text: "Loading WebLLM..." });
      const webllm = await import(LIBRARY);
      const record = webllm.prebuiltAppConfig.model_list.find(m => m.model_id === model);
      if (!record) throw new Error(`Model is not registered: ${model}`);
      for (const feature of record.required_features ?? []) {
        if (!adapter.features.has(feature)) throw new Error(`Missing GPU feature: ${feature}`);
      }
      if (record.buffer_size_required_bytes > adapter.limits.maxStorageBufferBindingSize) {
        throw new Error("The GPU buffer limit is too small for this model.");
      }
      engine = new webllm.MLCEngine({
        initProgressCallback: report => send("progress", report),
        logLevel: "WARN",
      });
      await engine.reload(model, { context_window_size: 4096 });
      send("result", { model });
    } else if (type === "benchmark") {
      if (!engine) throw new Error("No model is loaded.");
      const messages = [{ role: "user", content: "Explain how computers work in detail." }];
      await engine.resetChat();
      await engine.chat.completions.create({
        messages, temperature: 0, max_tokens: 8, ignore_eos: true,
      });
      await engine.resetChat();
      const start = performance.now();
      const reply = await engine.chat.completions.create({
        messages, temperature: 0, max_tokens: 32, ignore_eos: true,
      });
      const seconds = (performance.now() - start) / 1000;
      const tokens = reply.usage?.completion_tokens;
      if (!(tokens > 0 && seconds > 0)) throw new Error("Unable to measure speed.");
      await engine.resetChat();
      send("result", {
        tokens, seconds, score: tokens / seconds,
        decode: reply.usage?.extra?.decode_tokens_per_s ?? null,
      });
    } else if (type === "chat") {
      if (!engine) throw new Error("No model is loaded.");
      // Conservative byte guard for the selected Qwen models, not a tokenizer.
      if (!Array.isArray(data.messages) || data.messages.length > 8 ||
          new TextEncoder().encode(JSON.stringify(data.messages)).length > 3000) {
        throw new Error("Input is too large for this prototype.");
      }
      await engine.resetChat();
      let text = "", usage = null, finish = "";
      const start = performance.now();
      const chunks = await engine.chat.completions.create({
        messages: data.messages, stream: true,
        stream_options: { include_usage: true },
        max_tokens: 256, temperature: data.web ? 0.1 : 0.6,
      });
      for await (const chunk of chunks) {
        const delta = chunk.choices[0]?.delta?.content ?? "";
        text += delta;
        if (delta) send("delta", delta);
        if (chunk.usage) usage = chunk.usage;
        finish = chunk.choices[0]?.finish_reason || finish;
      }
      send("result", { text, usage, finish, seconds: (performance.now() - start) / 1000 });
    } else if (type === "unload") {
      if (engine) await engine.unload();
      engine = undefined;
      send("result", null);
    } else {
      throw new Error("Unknown operation.");
    }
  } catch (error) {
    send("error", error instanceof Error ? error.message : String(error));
  } finally {
    busy = false;
  }
};
