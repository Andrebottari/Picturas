const express = require("express");
const multer = require("multer");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const crypto = require("node:crypto");

const validarVideo = require("../services/validateVideo");
const uploadVideo = require("../services/uploadVideo");
//Verificar a autenticação interna antes de receber vídeos.
const {
  requireVideoInternalAuth,
} = require("../middleware/videoInternalAuth");

const router = express.Router();

//AB Os vídeos são guardados temporariamente em disco.
// Evitamos carregar ficheiros MP4 grandes integralmente na memória.
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, os.tmpdir());
    },

    filename: (req, file, cb) => {
      cb(null, `picturas-video-${crypto.randomUUID()}.tmp`);
    },
  }),

  //AB Limite técnico inicial.
  // Os limites por perfil serão aplicados numa fase posterior.
  limits: {
    fileSize: 500 * 1024 * 1024,
    files: 1,
  },

  fileFilter: (req, file, cb) => {
    if (
      file.mimetype !== "video/mp4" ||
      path.extname(file.originalname).toLowerCase() !== ".mp4"
    ) {
      return cb(
        new Error("Apenas ficheiros MP4 são permitidos.")
      );
    }

    cb(null, true);
  },
});

//AB Validar o vídeo sem interferir com a rota de imagens.
router.post(
  "/:userId/:projectId/:stage",
  requireVideoInternalAuth,
  (req, res) => {
  upload.single("file")(req, res, async (erroUpload) => {
    const caminhoTemporario = req.file?.path;

    try {
      if (erroUpload) {
        return res.status(400).json({
          error: erroUpload.message,
        });
      }

      if (!req.file) {
        return res.status(400).json({
          error: "Nenhum vídeo foi enviado.",
        });
      }

      const { stage } = req.params;

      if (!["src", "out"].includes(stage)) {
        return res.status(400).json({
          error: "O estágio deve ser src ou out.",
        });
      }

      //AB Validar o conteúdo real com FFprobe.
      let metadados;

      try {
        metadados = await validarVideo(req.file.path);
      } catch (erroValidacao) {
        return res.status(400).json({
          error: erroValidacao.message,
        });
      }

    //AB Guardar no SeaweedFS apenas depois da validação FFprobe.
      const { userId, projectId } = req.params;

      let resultadoArmazenamento;

      try {
        const processId = req.get("X-Video-Process-Id") ?? null;

    if (
        processId !== null &&
         (
            stage !== "out" ||
            typeof processId !== "string" ||
            processId.length === 0 ||
            processId.length > 256
    )
    ) {
        return res.status(400).json({
            error: "Identificador de processamento inválido.",
    });
    }

resultadoArmazenamento = await uploadVideo(
  userId,
  projectId,
  req.file.path,
  stage,
  processId
);
      } catch (erroArmazenamento) {
        console.error(
          "[VIDEO UPLOAD] Erro ao guardar vídeo no SeaweedFS:",
          erroArmazenamento
        );

        return res.status(502).json({
          error: "Não foi possível guardar o vídeo no armazenamento.",
        });
      }

      //AB Devolver os metadados e a chave S3 do vídeo armazenado.
      return res.status(200).json({
        message: "Vídeo carregado com sucesso.",
        data: {
          originalName: req.file.originalname,
          sizeBytes: req.file.size,
          ...metadados,
          videoKey: resultadoArmazenamento.videoKey,
        },
      });
    } catch (erro) {
      console.error("[VIDEO UPLOAD]", erro);

      return res.status(500).json({
        error: "Erro interno ao validar o vídeo.",
      });
    } finally {
      //AB Eliminar o ficheiro temporário depois do tratamento.
      if (caminhoTemporario) {
        try {
          await fs.promises.unlink(caminhoTemporario);
        } catch (erroLimpeza) {
          if (erroLimpeza.code !== "ENOENT") {
            console.error(
              "[VIDEO UPLOAD] Erro ao eliminar ficheiro temporário:",
              erroLimpeza
            );
          }
        }
      }
    }
  });
});

// Exportar a rota de armazenamento de vídeos.
module.exports = router;