//AB Validar a versão do projeto antes do carregamento do vídeo.
// Não alterar o middleware de versões utilizado pelas imagens.
function requireVideoProjectVersion(req, res, next) {
  const rawVersion = req.headers["x-project-version"];

  // Rejeitar cabeçalhos ausentes ou vazios.
  if (
    typeof rawVersion !== "string" ||
    rawVersion.trim() === ""
  ) {
    return res.status(428).json({
      message: "Cabeçalho X-Project-Version obrigatório.",
    });
  }

  // Aceitar apenas números inteiros não negativos.
  if (!/^(0|[1-9][0-9]*)$/.test(rawVersion)) {
    return res.status(400).json({
      message: "Versão do projeto inválida.",
    });
  }

  const expectedVersion = Number(rawVersion);

  if (!Number.isSafeInteger(expectedVersion)) {
    return res.status(400).json({
      message: "Versão do projeto inválida.",
    });
  }

  // Utilizar o projeto previamente validado no MongoDB.
  const project = req.videoProject;

  if (!project) {
    return res.status(500).json({
      message: "Projeto não validado.",
    });
  }

  // Rejeitar versões desatualizadas antes de armazenar o MP4.
  if (project.version !== expectedVersion) {
    return res.status(409).json({
      message: "Conflito de versão do projeto.",
      serverVersion: project.version,
    });
  }

  req.expectedVersion = expectedVersion;

  return next();
}

module.exports = { requireVideoProjectVersion };