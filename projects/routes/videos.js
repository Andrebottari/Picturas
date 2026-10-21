const express = require("express");
const fs = require("node:fs/promises");

const path = require("node:path");
const { randomUUID, createHmac } = require("node:crypto");

const axios = require("axios");
const https = require("node:https");
const fsSync = require("node:fs");
const videoQuotaAgent = new https.Agent({
  // Mantem a configuracao de comunicacao interna ja usada em projects.
  // A validacao do certificado interno deve ser reforcada futuramente.
  rejectUnauthorized: false,
  key: fsSync.readFileSync(path.join(__dirname, "../certs/selfsigned.key")),
  cert: fsSync.readFileSync(path.join(__dirname, "../certs/selfsigned.crt")),
});

const VideoProcess = require("../models/videoProcess");
const { validateSharedVideo } = require("../utils/videoLimits");

// HMAC interno: nunca expor este segredo/cabecalho ao browser.
async function refundVideoQuota(processo) {
  if (!processo?.actor_id || !processo?.msg_id || !process.env.JWT_SECRET_KEY) {
    throw new Error("Dados necessarios para reembolso indisponiveis.");
  }
  const actorId = String(processo.actor_id);
  const reservationId = String(processo.msg_id);
  const signature = createHmac("sha256", process.env.JWT_SECRET_KEY)
    .update(`uc03-refund-v1:${actorId}:${reservationId}`).digest("hex");
  const response = await axios.post("https://users:10001/video/quota/refund", { actorId, reservationId }, {
    httpsAgent: videoQuotaAgent,
    headers: { "X-Video-Quota-Signature": signature },
    timeout: 5000,
  });
  return response.data;
}


const {
  descarregarVideoOriginal,
} = require("../utils/videoSource");

const {
  publicarProcessamentoVideo,
} = require("../utils/videoQueue");

const router = express.Router();

// Conciliacao autonoma: so processamentos definitivamente falhados.
// Nunca inferir falha de mensagens ainda pendentes ou em processamento.
const { createQuotaRecovery, startQuotaRecovery } = require("../utils/videoQuotaRecovery");
const quotaRecovery = createQuotaRecovery({ VideoProcess, refundVideoQuota, log: console });
startQuotaRecovery(quotaRecovery, { intervalMs: 60000 });


const { requireVideoOwner } = require("../middleware/videoAuth");
const { requireVideoEditor } = require("../middleware/videoEditor");
const {
  requireVideoProjectOwner,
} = require("../middleware/videoProjectOwner");
const {
  requireVideoProjectVersion,
} = require("../middleware/videoProjectVersion");
const { videoUpload } = require("../middleware/videoUpload");

const Project = require("../controllers/project");
const { checkSharePermission } = require("../middleware/shareAuth");
// As leituras podem ser partilhadas. A autorização nunca usa apenas ?share:
// checkSharePermission consulta o MongoDB e confirma o vínculo ao projeto.
async function requireReadableVideoProject(req, res, next) {
  try {
    const found = await Project.getOne(req.params.user, req.params.project);
    if (!found) return res.status(404).json({ message: "Projeto não encontrado." });
    req.videoProject = found;
    return next();
  } catch (err) {
    console.error("[VIDEO SHARE] Projeto indisponível:", err.message);
    return res.status(404).json({ message: "Projeto não encontrado." });
  }
}

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
  requireVideoEditor,
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

    // Limites padrão da edição partilhada, configuráveis no serviço projects.
    // Não altera os limites históricos do proprietário.
    if (req.videoGuestEditor) {
      const validation = validateSharedVideo(projeto.video);
      if (!validation.ok) {
        return res.status(422).json({ message: validation.message });
      }
    }
    // No máximo uma execução ativa por projeto e por convidado.
    try {
      const activeProject = await VideoProcess.exists({
        user_id: userId, project_id: projectId, status: { $in: ["pending", "processing"] }
      });
      if (activeProject) return res.status(409).json({ message: "Já existe um processamento ativo neste projeto." });
      if (req.videoGuestEditor) {
        const activeActor = await VideoProcess.exists({
          actor_id: req.videoAuthenticatedUserId,
          status: { $in: ["pending", "processing"] }
        });
        if (activeActor) return res.status(429).json({ message: "Já tens um processamento ativo." });
      }
    } catch (error) {
      return res.status(503).json({ message: "Não foi possível verificar os processamentos ativos." });
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
    let quotaReservada = false;

    try {
      //AB Validar os filtros com as regras do modelo VideoProcess.
      processo = new VideoProcess({
        user_id: userId,
        project_id: projectId,
        actor_id: req.videoAuthenticatedUserId,
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


      // UC-03: cobrar uma operacao ao ator real (proprietario ou convidado).
      // A reserva e atomica no users-ms; nenhuma chamada a FFmpeg e publicada
      // quando a quota estiver esgotada ou o servico estiver indisponivel.
      try {
        await axios.post("https://users:10001/video/quota/reserve", { reservationId: messageId }, {
          httpsAgent: videoQuotaAgent,
          headers: { Authorization: req.headers.authorization },
          timeout: 5000,
        });
        quotaReservada = true;
      } catch (quotaError) {
        // Esta tarefa ainda nao foi publicada; invalidar antes de responder.
        await VideoProcess.findOneAndUpdate(
          { _id: processo._id, status: "pending" },
          { $set: { status: "failed", finished_at: new Date(),
              error_message: "Operacao nao publicada: quota indisponivel." } }
        );
        const status = quotaError.response?.status;
        if ([401, 403, 404, 429].includes(status)) {
          return res.status(status).json({
            message: quotaError.response?.data?.message || "Quota de video indisponivel."
          });
        }
        console.error("[VIDEO QUOTA] Falha no users-ms:", quotaError.message);
        return res.status(503).json({ message: "Nao foi possivel verificar a quota de video." });
      }

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

  if (quotaReservada) {
    try { await refundVideoQuota(processo); }
    catch (refundError) { console.error("[VIDEO QUOTA] Reembolso pendente:", refundError.message); }
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

// UC-03: devolver o MP4 original associado ao projeto, nunca uma chave fornecida
// pelo cliente. As verificacoes do proprietario acontecem antes do acesso S3.
router.get(
  "/:user/:project/video/original",
  checkSharePermission,
  requireReadableVideoProject,
  async (req, res) => {
    const { user, project } = req.params;
    const key = req.videoProject?.video?.original_key;
    const prefix = `${project}/src/`;
    const fileName = typeof key === "string" && key.startsWith(prefix)
      ? key.slice(prefix.length) : "";
    // Confirmar UUID canonico para impedir nomes arbitrarios.
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.mp4$/i.test(fileName)) {
      return res.status(404).json({ message: "Video original nao encontrado." });
    }
    const segredo = process.env.VIDEO_INTERNAL_SECRET;
    if (!segredo) return res.status(503).json({ message: "Armazenamento indisponivel." });
    const axios = require("axios");
    try {
      const resposta = await axios.get(
        `${process.env.VIDEO_STORAGE_URL || "http://img_storage:11000"}/video-source/${user}/${project}/${fileName}`,
        { responseType: "stream", timeout: 120000, maxRedirects: 0,
          headers: { "X-Video-Internal-Secret": segredo } }
      );
      res.set({
        "Content-Type": "video/mp4", "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      });
      if (resposta.headers["content-length"]) res.set("Content-Length", resposta.headers["content-length"]);
      resposta.data.on("error", (err) => { console.error("[VIDEO ORIGINAL] Stream:", err.message); res.destroy(err); });
      res.on("close", () => { if (!res.writableEnded) resposta.data.destroy(); });
      resposta.data.pipe(res);
    } catch (err) {
      console.error("[VIDEO ORIGINAL] Erro:", err.message);
      if (res.headersSent) return res.destroy(err);
      if (err.response?.data?.destroy) err.response.data.destroy();
      return res.status(err.response?.status === 404 ? 404 : 502).json({
        message: err.response?.status === 404 ? "Video original nao encontrado." : "Nao foi possivel recuperar o video original.",
      });
    }
  }
);

// UC-03: recuperar o ultimo processamento persistido no MongoDB e os metadados
// do video original. Nunca confiar em identificadores guardados no browser.
router.get(
  "/:user/:project/video/saved",
  checkSharePermission,
  requireReadableVideoProject,
  async (req, res) => {
    try {
      const { user, project } = req.params;
      const original = req.videoProject?.video ?? null;
      const latest = original?.original_key
        ? await VideoProcess.findOne({
            user_id: user,
            project_id: project,
            input_video_key: original.original_key,
          }).sort({ createdAt: -1, _id: -1 }).lean()
        : null;
      return res.status(200).json({
        original: original ? {
          name: original.original_name,
          sizeBytes: original.size_bytes,
          durationSeconds: original.duration_seconds,
        } : null,
        process: latest ? {
          processId: String(latest._id),
          status: latest.status,
          progress: latest.progress,
          filters: latest.filters,
          outputVideoKey: latest.output_video_key,
          errorMessage: latest.error_message,
        } : null,
      });
    } catch (err) {
      console.error("[VIDEO SAVED]", err.message);
      return res.status(503).json({ message: "Nao foi possivel recuperar o video guardado." });
    }
  }
);

//AB Consultar o estado de um processamento de vídeo do projeto.
router.get(
  "/:user/:project/video/process/:processId",
  checkSharePermission,
  requireReadableVideoProject,
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

      // Se o worker marcou uma falha definitiva, o polling permite
      // reconciliar o reembolso. O users-ms garante idempotencia.
      if (processo.status === "failed" && processo.actor_id && processo.msg_id) {
        try { await refundVideoQuota(processo); }
        catch (refundError) { console.error("[VIDEO QUOTA] Reembolso pendente:", refundError.message); }
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
  checkSharePermission,
  requireReadableVideoProject,
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
      // O nome do ficheiro é extraído da chave persistida e validada, nunca do pedido.
      const fileName = match[1];
      const segredo = process.env.VIDEO_INTERNAL_SECRET;
      if (!segredo) return res.status(503).json({ message: "Armazenamento indisponível." });
      const axios = require("axios");
      const resposta = await axios.get(
        `${process.env.VIDEO_STORAGE_URL || "http://img_storage:11000"}/video-output/${user}/${project}/${fileName}`,
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