import { modelInfo } from "./model-path.js";
import { getRuntime, runtimeState } from "./runtime.js";

/** Startup check: is a usable model present, and does it load? */
export async function ping() {
  const info = modelInfo();
  if (!info.path) return { ok: false, error: info.error, models: [] };
  try {
    const rt = await getRuntime();
    return { ok: true, path: rt.modelPath, device: rt.device, architecture: rt.architecture, models: [rt.modelPath] };
  } catch (err) {
    return { ok: false, error: String(err?.message || err).split("\n")[0], models: [info.path] };
  }
}

export async function status() {
  const info = modelInfo();
  return { ...runtimeState(), path: info.path, error: info.error, sizeBytes: info.sizeBytes };
}