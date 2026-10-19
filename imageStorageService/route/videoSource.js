const express = require("express");
const s3 = require("../services/s3Client");

const {
  requireVideoInternalAuth,
} = require("../middleware/videoInternalAuth");

const router = express.Router();

//AB Obter o vídeo original através de uma ligação interna autenticada.
router.get(
  "/:userId/:projectId/:fileName",
  requireVideoInternalAuth,
  (req, res) => {
    const { userId, projectId, fileName } = req.params;

    // Aceitar apenas identificadores MongoDB válidos.
    const objectIdRegex = /^[a-f0-9]{24}$/i;

    // Os originais são armazenados com nomes UUID.
    const originalRegex =
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.mp4$/i;

    if (
      !objectIdRegex.test(userId) ||
      !objectIdRegex.test(projectId) ||
      !originalRegex.test(fileName)
    ) {
      return res.status(400).json({
        message: "Identificadores de vídeo inválidos.",
      });
    }

    //AB O estágio src é fixo: nunca aceitar caminhos arbitrários.
    const bucket = `user-${userId}`;
    const key = `${projectId}/src/${fileName}`;

    const pedido = s3.getObject({
      Bucket: bucket,
      Key: key,
    });

    const stream = pedido.createReadStream();

    stream.once("error", (erro) => {
      console.error(
        "[VIDEO SOURCE] Erro ao obter vídeo:",
        erro.code || erro.message
      );

      if (!res.headersSent) {
        const naoEncontrado =
          erro.code === "NoSuchKey" ||
          erro.code === "NoSuchBucket" ||
          erro.code === "NotFound" ||
          erro.statusCode === 404;

        return res.status(naoEncontrado ? 404 : 502).json({
          message: naoEncontrado
            ? "Vídeo original não encontrado."
            : "Não foi possível obter o vídeo original.",
        });
      }

      res.destroy(erro);
    });

    res.set({
      "Content-Type": "video/mp4",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });

    //AB Transmitir o ficheiro sem o carregar inteiro na memória.
    stream.pipe(res);
  }
);

module.exports = router;