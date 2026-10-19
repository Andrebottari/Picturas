const jwt = require("jsonwebtoken");

//AB Verificar a assinatura do JWT no próprio serviço projects.
//AB Não confiar no cabeçalho X-Caller-Id enviado pelo cliente.
function requireVideoOwner(req, res, next) {
  const authorization = req.headers.authorization;

  if (
    typeof authorization !== "string" ||
    !authorization.startsWith("Bearer ")
  ) {
    return res.status(401).json({
      message: "Autenticação necessária para carregar vídeos.",
    });
  }

  const token = authorization.slice("Bearer ".length);

  if (!process.env.JWT_SECRET_KEY) {
    console.error("[VIDEO AUTH] JWT_SECRET_KEY não configurada.");

    return res.status(503).json({
      message: "Serviço de autenticação indisponível.",
    });
  }

  let payload;

  try {
    //AB Verificar a assinatura e a expiração do token.
    payload = jwt.verify(token, process.env.JWT_SECRET_KEY);
  } catch (_) {
    return res.status(401).json({
      message: "Token inválido ou expirado.",
    });
  }

  if (!payload || typeof payload.id !== "string") {
    return res.status(401).json({
      message: "Identificador do utilizador inválido.",
    });
  }

  //AB Nesta fase, apenas o proprietário pode carregar vídeos.
  if (payload.id !== req.params.user) {
    return res.status(403).json({
      message: "Sem permissão para carregar vídeos neste projeto.",
    });
  }

  req.videoAuthenticatedUserId = payload.id;

  return next();
}

module.exports = { requireVideoOwner };