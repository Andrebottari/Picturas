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
    console.warn(
      `[VIDEO] Execução não encontrada: ${resposta.correlationId}`
    );

    // Uma resposta sem execução correspondente não deve criar
    // automaticamente um processo ou associar ficheiros.
    return;
  }

  if (["completed", "failed", "cancelled"].includes(processo.status)) {
    console.log(
      `[VIDEO] Resposta ignorada: processo ${processo.msg_id} ` +
      `já está em estado ${processo.status}`
    );

    return;
  }

  if (resposta.status === "error") {
  //AB Atualizar apenas processos ainda ativos.
  // Evita substituir um cancelamento ocorrido entretanto.
  const atualizado = await VideoProcess.findOneAndUpdate(
    {
      _id: processo._id,
      status: { $in: ["pending", "processing"] },
    },
    {
      $set: {
        status: "failed",
        error_message:
          resposta.error?.message ||
          resposta.error?.msg ||
          "Erro no processamento de vídeo",
        finished_at: new Date(),
      },
    },
    {
      new: true,
      runValidators: true,
    }
  );

  if (!atualizado) {
    console.log(
      `[VIDEO] Erro ignorado: processo ${processo.msg_id} ` +
      "já foi terminado ou cancelado."
    );
    return;
  }

  console.log(`[VIDEO] Processo falhou: ${processo.msg_id}`);
  return;
}

    //AB Validar o vídeo produzido antes de o guardar no SeaweedFS.
  const caminhoRecebido = resposta.output.videoURI;
  const diretorioPermitido = "/app/images";

  if (!path.isAbsolute(caminhoRecebido)) {
    throw new Error("O caminho do vídeo processado não é absoluto.");
  }

  // Resolver links simbólicos para impedir o acesso fora do volume.
  const diretorioReal = await fs.realpath(diretorioPermitido);
  const caminhoReal = await fs.realpath(caminhoRecebido);

  const caminhoRelativo = path.relative(
    diretorioReal,
    caminhoReal
  );

  if (
    !caminhoRelativo ||
    caminhoRelativo === ".." ||
    caminhoRelativo.startsWith(`..${path.sep}`) ||
    path.isAbsolute(caminhoRelativo)
  ) {
    throw new Error("Vídeo processado fora do diretório permitido.");
  }

  if (path.extname(caminhoReal).toLowerCase() !== ".mp4") {
    throw new Error("O resultado do processamento não é um MP4.");
  }

  const informacao = await fs.stat(caminhoReal);

  if (!informacao.isFile() || informacao.size === 0) {
    throw new Error("O vídeo processado está vazio ou é inválido.");
  }

  //AB Guardar o resultado na área 'out' do projeto.
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
    throw new Error(
      "O armazenamento não devolveu uma chave de vídeo válida."
    );
  }

  //AB Concluir apenas um processo que ainda não foi terminado.
  const atualizado = await VideoProcess.findOneAndUpdate(
    {
      _id: processo._id,
      status: { $in: ["pending", "processing"] },
    },
    {
      $set: {
        status: "completed",
        progress: 100,
        output_video_key: videoKey,
        finished_at: new Date(),
        error_message: null,
      },
    },
    {
      new: true,
      runValidators: true,
    }
  );

  if (!atualizado) {
  //AB Consultar o estado atual antes de decidir sobre a limpeza.
  const estadoAtual = await VideoProcess.findById(processo._id);

  if (!estadoAtual) {
    console.warn(
      `[VIDEO] Processo removido durante o armazenamento: ${processo.msg_id}`
    );

    // Não eliminar automaticamente sem conhecer o estado atual.
    return;
  }

  if (estadoAtual.status === "completed") {
    console.log(
      `[VIDEO] Processo já concluído: ${processo.msg_id}`
    );

    // Não apagar um resultado que possa estar em utilização.
    return;
  }

  if (estadoAtual.status === "cancelled") {
    console.warn(
      `[VIDEO] Processo cancelado: ${processo.msg_id}`
    );

    // A chave estável pertence exclusivamente a este processamento.
    // Solicitar a eliminação do objeto resultante.
    await deleteVideoResult(
        String(processo.user_id),
         String(processo.project_id),
        videoKey
    );

      console.log(
        `[VIDEO] Resultado cancelado eliminado: ${processo.msg_id}`
    );

    //AB O worker já devolveu o resultado e o objeto armazenado foi eliminado.
    await limparResultadoConcluido(processo, caminhoRecebido);

    return;
    

    return;
  }

  console.warn(
    `[VIDEO] Estado inesperado após armazenamento: ${estadoAtual.status}`
  );
  return;
}

  console.log(
    `[VIDEO] Processamento concluído: ${processo.msg_id}`
  );

  //AB O resultado já está armazenado e o estado completed foi persistido.
await limparResultadoConcluido(processo, caminhoRecebido);
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

  console.log(
    "[VIDEO] Consumidor de resultados iniciado."
  );

  return { ligacao, canal };
}


module.exports = {
  validarResposta,
  tratarResultadoVideo,
  iniciarConsumidorVideo,
};