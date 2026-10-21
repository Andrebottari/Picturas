const express = require("express");
const fs = require("node:fs/promises");

const path = require("node:path");
const { randomUUID } = require("node:crypto");

const VideoProcess = require("../models/videoProcess");

const {
  descarregarVideoOriginal,
} = require("../utils/videoSource");

const {
  publicarProcessamentoVideo,
} = require("../utils/videoQueue");

const router = express.Router();

const { requireVideoOwner } = require("../middleware/videoAuth");
const {
  requireVideoProjectOwner,
} = require("../middleware/videoProjectOwner");
const {
  requireVideoProjectVersion,
} = require("../middleware/videoProjectVersion");
const { videoUpload } = require("../middleware/videoUpload");

const Project = require("../controllers/project");
const { postVideo } = require("../utils/videoStorage");

//AB Carregar o vídeo original de um projeto, sem alterar as imagens.
router.post(
  "/:user/:project/video",
  requireVideoOwner,
  requireVideoProjectOwner,
  requireVideoProjectVersion,
  (req, res, next) => {
    videoUpload.single("file")(req, res, (erro) => {
      if (erro) {
        return res.status(400).json({
          message: erro.message,
        });
      }

      return next();
    });
  },
  async (req, res) => {
    const userId = req.params.user;
    const projectId = req.params.project;

    const ficheiro = req.file;

    if (!ficheiro) {
      return res.status(400).json({
        message: "É necessário enviar um vídeo MP4 no campo file.",
      });
    }

    try {
      //AB O serviço de armazenamento valida o conteúdo com FFprobe.
      const resposta = await postVideo(
        userId,
        projectId,
        ficheiro.path,
        ficheiro.originalname,
        "src"
      );

      const dados = resposta?.data;

      // Não guardar metadados incompletos no projeto.
      if (
        !dados ||
        typeof dados.videoKey !== "string" ||
        !dados.videoKey.startsWith(`${projectId}/src/`) ||
        typeof dados.originalName !== "string" ||
        !Number.isSafeInteger(dados.sizeBytes) ||
        dados.sizeBytes <= 0 ||
        dados.mime_type !== "video/mp4" ||
        dados.codec !== "h264" ||
        !Number.isFinite(dados.duration_seconds) ||
        dados.duration_seconds <= 0 ||
        !Number.isFinite(dados.width) ||
        dados.width <= 0 ||
        !Number.isFinite(dados.height) ||
        dados.height <= 0
      ) {
        console.error(
          "[VIDEO UPLOAD] Resposta inválida do armazenamento."
        );

        return res.status(502).json({
          message: "O armazenamento devolveu metadados inválidos.",
        });
      }

      const video = {
        original_key: dados.videoKey,
        original_name: dados.originalName,
        mime_type: dados.mime_type,
        size_bytes: dados.sizeBytes,
        duration_seconds: dados.duration_seconds,
        width: dados.width,
        height: dados.height,
        uploaded_at: new Date(),
      };

      //AB Atualizar apenas o vídeo se a versão não tiver mudado.
      const projetoAtualizado = await Project.updateVideoIfVersion(
        userId,
        projectId,
        video,
        req.expectedVersion
      );

      if (!projetoAtualizado) {
        return res.status(409).json({
          message:
            "O projeto foi alterado durante o carregamento. " +
            "Atualiza o projeto e tenta novamente.",
        });
      }

      res.set(
        "X-Project-Version",
        String(projetoAtualizado.version)
      );

      return res.status(201).json({
        message: "Vídeo associado ao projeto com sucesso.",
        video: projetoAtualizado.video,
        projectVersion: projetoAtualizado.version,
      });
    } catch (erro) {
      console.error(
        "[VIDEO UPLOAD] Erro ao associar vídeo ao projeto:",
        erro.message
      );

      // Preservar erros de validação do armazenamento.
      const estadoArmazenamento = erro.response?.status;

      if (estadoArmazenamento === 400) {
        return res.status(400).json({
          message: "O ficheiro enviado não é um MP4 válido.",
        });
      }

      if (erro.name === "ValidationError") {
        return res.status(422).json({
          message: "Os metadados do vídeo são inválidos.",
        });
      }

      return res.status(502).json({
        message:
          "Não foi possível concluir o carregamento do vídeo.",
      });
    } finally {
      //AB Eliminar sempre o ficheiro temporário local.
      try {
        await fs.unlink(ficheiro.path);
      } catch (erroLimpeza) {
        if (erroLimpeza.code !== "ENOENT") {
          console.error(
            "[VIDEO UPLOAD] Erro na limpeza temporária:",
            erroLimpeza.message
          );
        }
      }
    }
  }
);
//AB Iniciar a aplicação assíncrona de filtros visuais a um vídeo.
router.post(
  "/:user/:project/video/process",
  requireVideoOwner,
  requireVideoProjectOwner,
  requireVideoProjectVersion,
  async (req, res) => {
    const userId = req.params.user;
    const projectId = req.params.project;

    // O projeto foi validado pelos middlewares anteriores.
    const projeto = req.videoProject;

    const videoKey = projeto?.video?.original_key;

    if (
      typeof videoKey !== "string" ||
      videoKey.length === 0
    ) {
      return res.status(400).json({
        message: "O projeto ainda não tem um vídeo original.",
      });
    }

    const filters = req.body?.filters;

    const messageId = randomUUID();

        //AB Usar o identificador da mensagem para identificar
        // também o diretório temporário deste processamento.
        const processId = messageId;

        const diretorio = path.join(
             "/app/images",
            "video-filters",
            processId
    );

    let processo = null;
    let publicado = false;
    let publicacaoIniciada = false;

    try {
      //AB Validar os filtros com as regras do modelo VideoProcess.
      processo = new VideoProcess({
        user_id: userId,
        project_id: projectId,
        msg_id: messageId,
        status: "pending",
        filters,
        input_video_key: videoKey,
      });

      await processo.validate();

      // Guardar o registo antes de enviar a mensagem ao worker.
      await processo.save();

      //AB Descarregar o original para o volume partilhado.
      const caminhos = await descarregarVideoOriginal(
        userId,
        projectId,
        videoKey,
        processId
      );

      const mensagem = {
        messageId,
        timestamp: new Date().toISOString(),
        procedure: "video_filters",
        parameters: {
          inputVideoURI: caminhos.inputVideoURI,
          outputVideoURI: caminhos.outputVideoURI,
          filters: processo.filters.map((filtro) => ({
            name: filtro.name,
            ...(filtro.value != null
              ? { value: filtro.value }
              : {}),
          })),
        },
      };


      //AB A partir daqui, uma falha pode ter confirmação RabbitMQ incerta.
      publicacaoIniciada = true;
      //AB Só publicar depois de o MP4 estar totalmente disponível.
      await publicarProcessamentoVideo(mensagem);

      publicado = true;

      return res.status(202).json({
        message: "Processamento de vídeo aceite.",
        processId: String(processo._id),
        messageId,
        status: "pending",
      });

    } catch (erro) {
      console.error(
        "[VIDEO PROCESS] Não foi possível iniciar o processamento:",
        erro.message
      );

      // Filtros inválidos são um erro do pedido.
      if (erro.name === "ValidationError") {
        return res.status(400).json({
          message: "Filtros ou parâmetros inválidos.",
        });
      }
//AB Se a publicação ainda não começou, a tarefa não foi enviada.
if (processo && !publicacaoIniciada) {
  try {
    await VideoProcess.findOneAndUpdate(
      {
        _id: processo._id,
        status: "pending",
      },
      {
        $set: {
          status: "failed",
          error_message:
            "Não foi possível preparar o vídeo para processamento.",
          finished_at: new Date(),
        },
      },
      {
        runValidators: true,
      }
    );
  } catch (erroMongo) {
    console.error(
      "[VIDEO PROCESS] Erro ao registar falha:",
      erroMongo.message
    );
  }

  return res.status(503).json({
    message:
      "Não foi possível preparar o vídeo para processamento.",
  });
}

//AB Preservar a identidade do processamento quando a publicação é incerta.
if (processo && publicacaoIniciada && !publicado) {
  console.error(
    "[VIDEO PROCESS] Publicação RabbitMQ sem confirmação:",
    processo.msg_id
  );

  return res.status(503).json({
    message:
      "Não foi possível confirmar a publicação. " +
      "Consulta o estado antes de tentares novamente.",
    processId: String(processo._id),
    messageId: processo.msg_id,
    status: "pending",
    publicationUncertain: true,
  });
}

return res.status(503).json({
  message:
    "Não foi possível confirmar o início do processamento.",
});
      if (processo && !publicado) {
        console.error(
          "[VIDEO PROCESS] Processamento sem publicação confirmada:",
          processo.msg_id
        );
      }

      return res.status(503).json({
        message:
          "Não foi possível confirmar o início do processamento.",
      });
    }
  }
);

//AB Consultar o estado de um processamento de vídeo do projeto.
router.get(
  "/:user/:project/video/process/:processId",
  requireVideoOwner,
  requireVideoProjectOwner,
  async (req, res) => {
    const { user, project, processId } = req.params;

    // Rejeitar identificadores MongoDB inválidos.
    if (!/^[a-f0-9]{24}$/i.test(processId)) {
      return res.status(400).json({
        message: "Identificador de processamento inválido.",
      });
    }

    try {
      //AB Restringir a consulta ao proprietário e ao projeto autenticados.
      const processo = await VideoProcess.findOne({
        _id: processId,
        user_id: user,
        project_id: project,
      }).lean();

      if (!processo) {
        return res.status(404).json({
          message: "Processamento de vídeo não encontrado.",
        });
      }

      return res.status(200).json({
        processId: String(processo._id),
        status: processo.status,
        progress: processo.progress,
        filters: processo.filters,
        outputVideoKey: processo.output_video_key,
        errorMessage: processo.error_message,
        createdAt: processo.created_at,
        startedAt: processo.started_at,
        finishedAt: processo.finished_at,
      });
    } catch (erro) {
      console.error(
        "[VIDEO PROCESS] Erro ao consultar processamento:",
        erro.message
      );

      return res.status(503).json({
        message: "Não foi possível consultar o processamento.",
      });
    }
  }
);

//AB UC-03: apenas o proprietário autenticado pode ler o resultado de uma execução concluída.
//AB O nome S3 nunca é fornecido pelo cliente: vem do registo validado no MongoDB.
router.get(
  "/:user/:project/video/process/:processId/result",
  requireVideoOwner,
  requireVideoProjectOwner,
  async (req, res) => {
    const { user, project, processId } = req.params;
    if (!/^[a-f0-9]{24}$/i.test(processId)) {
      return res.status(400).json({ message: "Identificador de processamento inválido." });
    }
    try {
      const processo = await VideoProcess.findOne({
        _id: processId, user_id: user, project_id: project, status: "completed",
      }).lean();
      if (!processo) {
        return res.status(404).json({ message: "Resultado de vídeo não encontrado." });
      }
      const key = processo.output_video_key;
      const match = typeof key === "string" &&
        key.match(new RegExp(`^${project}/out/([a-f0-9]{64}\\.mp4)$`));
      if (!match) {
        return res.status(409).json({ message: "Resultado de vídeo inválido ou indisponível." });
      }
      const segredo = process.env.VIDEO_INTERNAL_SECRET;
      if (!segredo) return res.status(503).json({ message: "Armazenamento indisponível." });
      const axios = require("axios");
      const resposta = await axios.get(
        `${process.env.VIDEO_STORAGE_URL || "http://img_storage:11000"}/video-output/${user}/${project}/${match[1]}`,
        { responseType: "stream", timeout: 120000, maxRedirects: 0,
          headers: { "X-Video-Internal-Secret": segredo } }
      );
      res.set({
        "Content-Type": "video/mp4", "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition": `attachment; filename="picturas-${processId}.mp4"`,
      });
      if (resposta.headers["content-length"]) {
        res.set("Content-Length", resposta.headers["content-length"]);
      }
      resposta.data.on("error", (err) => { console.error("[VIDEO RESULT] Stream:", err.message); res.destroy(err); });
      res.on("close", () => { if (!res.writableEnded) resposta.data.destroy(); });
      resposta.data.pipe(res);
    } catch (err) {
      console.error("[VIDEO RESULT] Falha:", err.message);
      if (res.headersSent) return res.destroy(err);
      const code = err.response?.status;
      return res.status(code === 404 ? 404 : 502).json({
        message: code === 404 ? "Vídeo processado não encontrado." : "Não foi possível obter o MP4 processado.",
      });
    }
  }
);

//AB Cancelar um processamento de vídeo ainda não concluído.
router.delete(
  "/:user/:project/video/process/:processId",
  requireVideoOwner,
  requireVideoProjectOwner,
  async (req, res) => {
    const { user, project, processId } = req.params;

    if (!/^[a-f0-9]{24}$/i.test(processId)) {
      return res.status(400).json({
        message: "Identificador de processamento inválido.",
      });
    }

    try {
      //AB Alterar o estado apenas se o processamento ainda estiver ativo.
      const processo = await VideoProcess.findOneAndUpdate(
        {
          _id: processId,
          user_id: user,
          project_id: project,
          status: {
            $in: ["pending", "processing"],
          },
        },
        {
          $set: {
            status: "cancelled",
            finished_at: new Date(),
          },
        },
        {
          new: true,
          runValidators: true,
        }
      );

      if (processo) {
        return res.status(200).json({
          message: "Processamento de vídeo cancelado.",
          processId: String(processo._id),
          status: processo.status,
        });
      }

      // Pode não existir ou já estar num estado terminal.
      const existente = await VideoProcess.findOne({
        _id: processId,
        user_id: user,
        project_id: project,
      });

      if (!existente) {
        return res.status(404).json({
          message: "Processamento de vídeo não encontrado.",
        });
      }

      if (existente.status === "cancelled") {
        return res.status(200).json({
          message: "O processamento já estava cancelado.",
          processId: String(existente._id),
          status: "cancelled",
        });
      }

      return res.status(409).json({
        message:
          "Não é possível cancelar um processamento já terminado.",
        processId: String(existente._id),
        status: existente.status,
      });
    } catch (erro) {
      console.error(
        "[VIDEO PROCESS] Erro ao cancelar processamento:",
        erro.message
      );

      return res.status(503).json({
        message: "Não foi possível cancelar o processamento.",
      });
    }
  }
);

module.exports = router;