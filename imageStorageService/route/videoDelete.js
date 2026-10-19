const express = require("express");
const deleteFile = require("../services/deleteFile");

const {
  requireVideoInternalAuth,
} = require("../middleware/videoInternalAuth");

const router = express.Router();

//AB Eliminar exclusivamente resultados de vídeo por pedido interno autenticado.
router.delete(
  "/:userId/:projectId/:fileName",
  requireVideoInternalAuth,
  async (req, res) => {
    const { userId, projectId, fileName } = req.params;

    // Os resultados usam o hash SHA-256 do identificador do processamento.
    if (!/^[a-f0-9]{64}\.mp4$/.test(fileName)) {
      return res.status(400).json({
        error: "Nome do resultado de vídeo inválido.",
      });
    }

    if (
      !/^[a-f0-9]{24}$/i.test(userId) ||
      !/^[a-f0-9]{24}$/i.test(projectId)
    ) {
      return res.status(400).json({
        error: "Utilizador ou projeto inválido.",
      });
    }

    try {
      // Esta rota nunca permite eliminar ficheiros src ou imagens.
      const resultado = await deleteFile(
        userId,
        projectId,
        "out",
        fileName
      );

      return res.status(200).json(resultado);
    } catch (erro) {
      console.error(
        "[VIDEO DELETE] Falha ao eliminar resultado:",
        erro.message
      );

      return res.status(502).json({
        error: "Não foi possível eliminar o resultado de vídeo.",
      });
    }
  }
);

module.exports = router;