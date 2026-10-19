const amqp = require("amqplib");

//AB Publicar pedidos de vídeo sem alterar o RabbitMQ das imagens.
async function publicarProcessamentoVideo(mensagem) {
  if (
    !mensagem ||
    typeof mensagem.messageId !== "string" ||
    mensagem.procedure !== "video_filters" ||
    !mensagem.parameters
  ) {
    throw new Error("Mensagem de processamento de vídeo inválida.");
  }

  const host = process.env.RABBITMQ_HOST;
  const port = process.env.RABBITMQ_PORT || "5672";
  const user = process.env.RABBITMQ_USER;
  const password = process.env.RABBITMQ_PASS;

  if (!host || !user || !password) {
    throw new Error("Configuração RabbitMQ incompleta.");
  }

  const url =
    `amqp://${encodeURIComponent(user)}:` +
    `${encodeURIComponent(password)}@${host}:${port}`;

  let conexao;
  let canal;

  try {
    conexao = await amqp.connect(url);

    //AB Confirmar que o RabbitMQ recebeu a publicação.
    canal = await conexao.createConfirmChannel();

    // A fila é persistente e independente das filas de imagens.
    await canal.assertQueue("video_filters_queue", {
      durable: true,
    });

    const conteudo = Buffer.from(
      JSON.stringify(mensagem),
      "utf8"
    );

    // Publicação na exchange predefinida:
    // encaminha diretamente para a fila indicada.
    await new Promise((resolve, reject) => {
      canal.sendToQueue(
        "video_filters_queue",
        conteudo,
        {
          persistent: true,
          contentType: "application/json",
          messageId: mensagem.messageId,
        },
        (erro) => {
          if (erro) {
            reject(erro);
          } else {
            resolve();
          }
        }
      );
    });

    return {
      messageId: mensagem.messageId,
      published: true,
    };
  } finally {
    if (canal) {
      await canal.close().catch(() => {});
    }

    if (conexao) {
      await conexao.close().catch(() => {});
    }
  }
}

module.exports = {
  publicarProcessamentoVideo,
};