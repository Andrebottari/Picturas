const amqp = require("amqplib");

const VideoProcess = require("../models/videoProcess");

// Limpeza dos ficheiros temporários após processamento.
const {
  limparFicheirosVideo,
} = require("./videoCleanup");

const fs = require("node:fs/promises");
const path = require("node:path");

const {
  postVideo,
  deleteVideoResult,
} = require("./videoStorage");

const EXCHANGE = "picturas";
const RESULTS_QUEUE = "video_results_queue";

//AB Uma execução abandonada é assinalada como falhada, nunca reexecutada.
//AB Margem deliberadamente grande para falhas transitórias de rede.
const ABANDONO_MS = 30 * 60 * 1000;
const VERIFICACAO_MS = 5 * 60 * 1000;

const rabbitHost = process.env.RABBITMQ_HOST;
const rabbitPort = process.env.RABBITMQ_PORT;
const rabbitUser = process.env.RABBITMQ_USER;
const rabbitPass = process.env.RABBITMQ_PASS;


//AB Construir a ligação RabbitMQ utilizando as variáveis
// de ambiente do serviço projects.
function rabbitUrl() {
  if (!rabbitHost || !rabbitPort || !rabbitUser || !rabbitPass) {
    throw new Error(
      "Configuração RabbitMQ incompleta no serviço projects."
    );
  }

  return (
    `amqp://${encodeURIComponent(rabbitUser)}:` +
    `${encodeURIComponent(rabbitPass)}@${rabbitHost}:${rabbitPort}`
  );
}


//AB Validar a estrutura básica da resposta do worker.
function validarResposta(resposta) {
  if (!resposta || typeof resposta !== "object") {
    throw new Error("Resposta RabbitMQ inválida.");
  }

  if (
    typeof resposta.correlationId !== "string" ||
    !resposta.correlationId
  ) {
    throw new Error("Resposta sem correlationId válido.");
  }

  if (!["success", "error"].includes(resposta.status)) {
    throw new Error("Estado da resposta inválido.");
  }

  //AB Vincular cada resultado à tentativa e ao worker que a reclamou.
  if (
    typeof resposta.metadata?.workerId !== "string" ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(resposta.metadata.workerId) ||
    !Number.isSafeInteger(resposta.metadata.attempt) ||
    resposta.metadata.attempt < 1
  ) {
    throw new Error("Resultado sem identidade de tentativa válida.");
  }

  if (resposta.status === "success") {
    if (
      resposta.output?.type !== "video" ||
      typeof resposta.output.videoURI !== "string" ||
      !resposta.output.videoURI
    ) {
      throw new Error("Resultado de vídeo inválido.");
    }
  }

  return resposta;
}


//AB Limpar apenas ficheiros associados à mensagem deste processamento.
async function limparResultadoConcluido(processo, caminhoVideo) {
  const diretorio = path.dirname(caminhoVideo);
  const identificadorDiretorio = path.basename(diretorio);

  // Impedir a limpeza de ficheiros de outra execução.
  // Processamentos antigos podem ter um UUID de diretório diferente.
  if (identificadorDiretorio !== processo.msg_id) {
    console.warn(
      `[VIDEO] Limpeza ignorada: diretório não corresponde ` +
      `à mensagem ${processo.msg_id}`
    );

    return;
  }

  try {
    await limparFicheirosVideo(caminhoVideo);

    console.log(
      `[VIDEO] Ficheiros temporários eliminados: ${processo.msg_id}`
    );
  } catch (erro) {
    // Uma falha de limpeza não deve reverter um processamento concluído
    // nem provocar uma nova gravação do resultado no SeaweedFS.
    console.error(
      `[VIDEO] Falha na limpeza de ${processo.msg_id}:`,
      erro.message
    );
  }
}

//AB Tratar uma resposta sem modificar os processos de imagens.
async function tratarResultadoVideo(resposta) {
  validarResposta(resposta);

  const processo = await VideoProcess.findOne({
    msg_id: resposta.correlationId,
  });

  if (!processo) {
    console.warn(`[VIDEO] Execução não encontrada: ${resposta.correlationId}`);
    return;
  }

  //AB Mensagens antigas, de outro worker ou de estados terminais não
  //AB podem alterar os dados, nem enviar objetos para o armazenamento.
  if (
    processo.status !== "processing" ||
    processo.worker_id !== resposta.metadata.workerId ||
    processo.attempt !== resposta.metadata.attempt
  ) {
    console.warn(`[VIDEO] Resultado de tentativa inválida: ${processo.msg_id}`);
    return;
  }

  const identidade = {
    _id: processo._id,
    status: "processing",
    worker_id: resposta.metadata.workerId,
    attempt: resposta.metadata.attempt,
  };

  if (resposta.status === "error") {
    const atualizado = await VideoProcess.findOneAndUpdate(
      identidade,
      {
        $set: {
          status: "failed",
          error_message:
            resposta.error?.message || resposta.error?.msg ||
            "Erro no processamento de vídeo",
          finished_at: new Date(),
        },
      },
      { new: true, runValidators: true }
    );
    if (atualizado) {
      console.log(`[VIDEO] Processo falhou: ${processo.msg_id}`);
    }
    return;
  }

  //AB Aceitar apenas o output esperado para esta mensagem.
  const caminhoRecebido = resposta.output.videoURI;
  const caminhoEsperado = path.join(
    "/app/images", "video-filters", processo.msg_id, "output.mp4"
  );
  if (caminhoRecebido !== caminhoEsperado) {
    throw new Error("O resultado não corresponde ao caminho deste processo.");
  }

  //AB Impedir symlinks e acesso fora do volume partilhado.
  const diretorioReal = await fs.realpath("/app/images");
  const caminhoReal = await fs.realpath(caminhoRecebido);
  const relativo = path.relative(diretorioReal, caminhoReal);
  if (
    !relativo || relativo === ".." ||
    relativo.startsWith(`..${path.sep}`) || path.isAbsolute(relativo)
  ) {
    throw new Error("Vídeo processado fora do diretório permitido.");
  }
  const informacao = await fs.stat(caminhoReal);
  if (!informacao.isFile() || informacao.size === 0) {
    throw new Error("O vídeo processado está vazio ou é inválido.");
  }

  //AB A escrita no armazenamento precede a operação atómica no MongoDB.
  //AB A chave de saída por msg_id é estável para reentregas da mensagem.
  const resultado = await postVideo(
    String(processo.user_id),
    String(processo.project_id),
    caminhoReal,
    path.basename(caminhoReal),
    "out",
    processo.msg_id
  );
  const videoKey = resultado?.data?.videoKey;
  if (typeof videoKey !== "string" || !videoKey) {
    throw new Error("O armazenamento não devolveu uma chave válida.");
  }

  const atualizado = await VideoProcess.findOneAndUpdate(
    identidade,
    {
      $set: {
        status: "completed",
        progress: 100,
        output_video_key: videoKey,
        finished_at: new Date(),
        error_message: null,
      },
    },
    { new: true, runValidators: true }
  );

  if (!atualizado) {
    const estadoAtual = await VideoProcess.findById(processo._id);
    if (estadoAtual?.status === "cancelled") {
      //AB Apenas depois da mudança para cancelled podemos eliminar
      //AB o objeto estável desta execução.
      await deleteVideoResult(
        String(processo.user_id), String(processo.project_id), videoKey
      );
      await limparResultadoConcluido(processo, caminhoRecebido);
    } else {
      //AB Nunca eliminar um resultado potencialmente em uso.
      console.warn(`[VIDEO] Resultado ignorado após alteração de estado: ${processo.msg_id}`);
    }
    return;
  }

  console.log(`[VIDEO] Processamento concluído: ${processo.msg_id}`);
  await limparResultadoConcluido(processo, caminhoRecebido);
}

//AB Fechar estados antigos sem reexecutar FFmpeg nem reclamar a mensagem.
//AB O utilizador poderá iniciar um novo processamento manualmente.
async function sinalizarProcessosAbandonados(agora = new Date()) {
  const limite = new Date(agora.getTime() - ABANDONO_MS);
  const processing = await VideoProcess.updateMany(
    { status: "processing", last_heartbeat_at: { $lt: limite } },
    {
      $set: {
        status: "failed",
        finished_at: agora,
        error_message: "Processamento interrompido: atividade do worker expirada.",
      },
    }
  );
  const pending = await VideoProcess.updateMany(
    { status: "pending", createdAt: { $lt: limite } },
    {
      $set: {
        status: "failed",
        finished_at: agora,
        error_message: "Processamento não iniciado dentro do prazo.",
      },
    }
  );
  return { processing: processing.modifiedCount, pending: pending.modifiedCount };
}

//AB Consumidor independente para resultados de vídeo.
async function iniciarConsumidorVideo() {
  const ligacao = await amqp.connect(rabbitUrl());

  const canal = await ligacao.createChannel();

  await canal.assertExchange(EXCHANGE, "direct", {
    durable: true,
  });

  await canal.assertQueue(RESULTS_QUEUE, {
    durable: true,
  });

  await canal.bindQueue(
    RESULTS_QUEUE,
    EXCHANGE,
    RESULTS_QUEUE
  );

  await canal.prefetch(1);

  await canal.consume(
    RESULTS_QUEUE,
    async (mensagem) => {
      if (!mensagem) {
        return;
      }

      let resposta;

      try {
        resposta = JSON.parse(mensagem.content.toString());

        validarResposta(resposta);

      } catch (erro) {
        console.error(
          "[VIDEO] Mensagem inválida:",
          erro.message
        );

        // Mensagens inválidas não são reenviadas indefinidamente.
        // Antes da entrada em produção, deverá existir
        // uma política de dead-letter e auditoria.
        canal.nack(mensagem, false, false);
        return;
      }

      try {
        await tratarResultadoVideo(resposta);

        // A confirmação só acontece depois do tratamento.
        canal.ack(mensagem);

      } catch (erro) {
        console.error(
          "[VIDEO] Falha ao tratar resultado:",
          erro
        );

        // Falha transitória: permitir nova tentativa.
        // Ainda será necessário limitar tentativas repetidas.
        canal.nack(mensagem, false, true);
      }
    },
    {
      noAck: false,
    }
  );

  //AB Verificação limitada; erros não devem terminar o consumidor.
  const verificar = async () => {
    try {
      const total = await sinalizarProcessosAbandonados();
      if (total.processing || total.pending) {
        console.warn("[VIDEO] Processamentos abandonados sinalizados:", total);
      }
    } catch (erro) {
      console.error("[VIDEO] Falha na verificação de abandono:", erro.message);
    }
  };
  const temporizador = setInterval(verificar, VERIFICACAO_MS);
  temporizador.unref?.();
  ligacao.on("close", () => clearInterval(temporizador));
  ligacao.on("error", (erro) => {
    console.error("[VIDEO] Ligação RabbitMQ com erro:", erro.message);
  });
  await verificar();

  console.log("[VIDEO] Consumidor de resultados iniciado.");
  return { ligacao, canal };
}


module.exports = {
  validarResposta,
  tratarResultadoVideo,
  iniciarConsumidorVideo,
  sinalizarProcessosAbandonados,
};