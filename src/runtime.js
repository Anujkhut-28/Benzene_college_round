import { findModel } from "./model-path.js";

const CONTEXT_SIZE = Number(process.env.HANDSFREE_CONTEXT) || 4096;
const GPU_PREF = (process.env.HANDSFREE_GPU ?? "true").toLowerCase() !== "false";

let runtime = null;
let loading = null;
let lastErr = null;
const listeners = new Set();

export function onRuntimeChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function emit(state) {
  for (const fn of listeners) fn(state);
}

/**
 * Load the decision model in-process. No external server, no API key.
 * Tries the GPU first and falls back to CPU when the context cannot be allocated
 * (typically because another process is holding VRAM).
 */
export async function getRuntime() {
  if (runtime) return runtime;
  if (loading) return loading;

  loading = (async () => {
    const modelPath = findModel();
    const { getLlama } = await import("node-llama-cpp");

    const attempt = async (gpu) => {
      const llama = await getLlama(gpu ? {} : { gpu: false });
      const model = await llama.loadModel({ modelPath });
      const context = await model.createDecisionContext({ contextSize: CONTEXT_SIZE });
      return { llama, model, context, device: gpu ? (llama.gpu === false ? "cpu" : "gpu") : "cpu" };
    };

    if (GPU_PREF) {
      emit({ status: "loading", device: "gpu" });
      try {
        runtime = await attempt(true);
      } catch (err) {
        lastErr = err;
        console.warn(`[handsfree] GPU init failed (${short(err)}); retrying on CPU`);
      }
    }
    if (!runtime) {
      emit({ status: "loading", device: "cpu" });
      try {
        runtime = await attempt(false);
      } catch (err) {
        // Surface the CPU failure to the caller; the GPU error alone is misleading
        // because "no GPU" is the expected path on most machines.
        lastErr = err;
        throw err;
      }
    }

    runtime.modelPath = modelPath;
    runtime.architecture = runtime.model.architecture;
    emit({ status: "ready", device: runtime.device, architecture: runtime.architecture });
    return runtime;
  })();

  try {
    return await loading;
  } catch (err) {
    lastErrSafe(err);
    throw lastErr || err;
  } finally {
    loading = null;
  }
}

function lastErrSafe(err) {
  console.error(`[handsfree] model load failed: ${short(err)}`);
}

function short(err) {
  return String(err?.message || err).split("\n")[0].slice(0, 160);
}

export function runtimeState() {
  if (!runtime) return { status: "idle", device: null };
  return { status: "ready", device: runtime.device, architecture: runtime.architecture, modelPath: runtime.modelPath };
}

/** True once a model can answer without any network or key. */
export function isLocalReady() {
  return Boolean(runtime);
}