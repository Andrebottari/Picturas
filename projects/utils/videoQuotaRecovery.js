"use strict";

// Executado no servidor projects. Sem chamadas do navegador nem JWT do cliente.
// O users-ms garante idempotencia por reservationId no MongoDB.
function createQuotaRecovery({ VideoProcess, refundVideoQuota, log = console, batchSize = 30 }) {
  if (!VideoProcess || typeof refundVideoQuota !== "function") throw new Error("Dependencias invalidas");
  let running = false;

  async function runOnce() {
    if (running) return { skipped: true };
    running = true;
    let settled = 0;
    let pending = 0;
    try {
      // Sem prazo automatico: pending / processing nao sao falhas definitivas.
      const records = await VideoProcess.find({
        status: "failed",
        actor_id: { $exists: true, $ne: null },
        msg_id: { $exists: true, $ne: null },
        quota_reconciled_at: { $exists: false },
      }).sort({ finished_at: 1, _id: 1 }).limit(batchSize).lean();

      for (const process of records) {
        try {
          const response = await refundVideoQuota(process);
          const result = response?.refunded === true ? "refunded" :
            response?.reason === "already-refunded" ? "already-refunded" :
            response?.reason === "not-found" ? "not-reserved" : null;
          // Respostas ambiguas nao sao consideradas reconciliadas: repetir depois.
          if (!result) { pending++; continue; }
          await VideoProcess.findOneAndUpdate(
            { _id: process._id, status: "failed", quota_reconciled_at: { $exists: false } },
            { $set: { quota_reconciled_at: new Date(), quota_reconciliation_result: result } }
          );
          settled++;
        } catch (error) {
          pending++;
          log.error("[VIDEO QUOTA] Reconciliacao pendente:", error.message);
        }
      }
      return { settled, pending };
    } finally {
      running = false;
    }
  }
  return { runOnce };
}

function startQuotaRecovery(recovery, { intervalMs = 60000 } = {}) {
  // Na inicializacao do projects o Mongoose pode ainda estar a ligar-se.
  // O primeiro ciclo ocorre apos intervalMs.
  const timer = setInterval(() => {
    recovery.runOnce().catch(e => console.error("[VIDEO QUOTA] Ciclo falhou:", e.message));
  }, intervalMs);
  timer.unref?.();
  return timer;
}

module.exports = { createQuotaRecovery, startQuotaRecovery };
