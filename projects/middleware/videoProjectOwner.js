const mongoose = require("mongoose");
const Project = require("../controllers/project");

//AB Confirmar que o projeto pertence ao utilizador autenticado.
//AB Executar esta verificação antes de aceitar o carregamento do vídeo.
async function requireVideoProjectOwner(req, res, next) {
  const userId = req.videoAuthenticatedUserId;
  const projectId = req.params.project;

  //AB Exigir uma identidade previamente validada por requireVideoOwner.
  if (!userId) {
    return res.status(401).json({
      message: "Autenticação necessária.",
    });
  }

  //AB Validar os identificadores antes de consultar o MongoDB.
  if (
    !mongoose.isObjectIdOrHexString(userId) ||
    !mongoose.isObjectIdOrHexString(projectId)
  ) {
    return res.status(400).json({
      message: "Identificador de utilizador ou projeto inválido.",
    });
  }

  try {
    //AB Consultar o projeto com o proprietário autenticado.
    const project = await Project.getOne(userId, projectId);

    if (!project) {
      return res.status(404).json({
        message: "Projeto não encontrado.",
      });
    }

    //AB Disponibilizar o projeto validado aos próximos middlewares.
    req.videoProject = project;

    return next();
  } catch (erro) {
    console.error(
      "[VIDEO AUTH] Erro ao verificar a propriedade do projeto:",
      erro.message
    );

    return res.status(503).json({
      message: "Não foi possível verificar o projeto.",
    });
  }
}

module.exports = { requireVideoProjectOwner };