const crypto = require("node:crypto");

//AB Proteger os pedidos internos de armazenamento de vídeos.
function requireVideoInternalAuth(req, res, next) {
  const segredoEsperado = process.env.VIDEO_INTERNAL_SECRET;
  const segredoRecebido = req.headers["x-video-internal-secret"];

  // Recusar pedidos quando o segredo interno não está configurado.
  if (!segredoEsperado) {
    console.error("[VIDEO AUTH] Segredo interno não configurado.");

    return res.status(503).json({
      message: "Autenticação interna indisponível.",
    });
  }

  // Exigir o cabeçalho de autenticação interna.
  if (typeof segredoRecebido !== "string") {
    return res.status(401).json({
      message: "Autenticação interna necessária.",
    });
  }

  // Produzir valores de comprimento fixo para comparação segura.
  const esperado = crypto
    .createHash("sha256")
    .update(segredoEsperado)
    .digest();

  const recebido = crypto
    .createHash("sha256")
    .update(segredoRecebido)
    .digest();

  if (!crypto.timingSafeEqual(esperado, recebido)) {
    return res.status(401).json({
      message: "Credencial interna inválida.",
    });
  }

  return next();
}

module.exports = { requireVideoInternalAuth };