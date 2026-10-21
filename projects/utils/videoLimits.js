"use strict";

// Limites existentes no UC-03, tornados explícitos e reutilizáveis.
// A configuração é lida ao iniciar o serviço projects.
function positiveInteger(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} deve ser um inteiro positivo.`);
  }
  return value;
}

const limits = Object.freeze({
  maxDurationSeconds: positiveInteger("VIDEO_SHARED_MAX_SECONDS", 30),
  maxSizeBytes: positiveInteger("VIDEO_SHARED_MAX_MB", 50) * 1024 * 1024,
  maxWidth: positiveInteger("VIDEO_SHARED_MAX_WIDTH", 1280),
  maxHeight: positiveInteger("VIDEO_SHARED_MAX_HEIGHT", 720),
});

function validateSharedVideo(video) {
  const v = video || {};
  const valid = Number.isFinite(v.duration_seconds) && v.duration_seconds > 0 &&
    v.duration_seconds <= limits.maxDurationSeconds &&
    Number.isFinite(v.size_bytes) && v.size_bytes > 0 &&
    v.size_bytes <= limits.maxSizeBytes &&
    Number.isFinite(v.width) && v.width > 0 && v.width <= limits.maxWidth &&
    Number.isFinite(v.height) && v.height > 0 && v.height <= limits.maxHeight;
  return valid
    ? { ok: true }
    : { ok: false, message: `O vídeo partilhado excede os limites: ${limits.maxDurationSeconds} s, ${Math.floor(limits.maxSizeBytes / 1024 / 1024)} MB e ${limits.maxWidth}×${limits.maxHeight} px.` };
}

module.exports = { limits, validateSharedVideo };
