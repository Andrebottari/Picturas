const express = require("express");
const VideoProcess = require("../models/videoProcess");

const router = express.Router();

//AB Autenticação exclusiva para comunicação interna entre serviços.
function autenticarServicoInterno(req, res, next) {
  const segredoEsperado = process.env.VIDEO_INTERNAL_SECRET;
  const segredoRecebido = req.get("X-Video-Internal-Secret");

  if (
    !segredoEsperado ||
    !segredoRecebido ||
    segredoRecebido !== segredoEsperado
  ) {
    return res.status(401).json({
      message: "Acesso interno não autorizado.",
    });
  }

  next();
}

//AB Reclamar atomicamente um processamento antes de executar FFmpeg.
router.post("/claim", autenticarServicoInterno, async (req, res) => {
  const { messageId, workerId } = req.body || {};

  //AB Validar o identificador da mensagem RabbitMQ.
  if (
    typeof messageId !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
      messageId
    )
  ) {
    return res.status(400).json({
      message: "messageId inválido.",
    });
  }

  //AB Identificar o worker que pretende reclamar a execução.
  if (
    typeof workerId !== "string" ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(workerId)
  ) {
    return res.status(400).json({
      message: "workerId inválido.",
    });
  }

  try {
    //AB Reclamar a tarefa e registar o worker na mesma operação atómica.
    const agora = new Date();

    const reclamado = await VideoProcess.findOneAndUpdate(
      {
        msg_id: messageId,
        status: "pending",
      },
      {
        $set: {
          status: "processing",
          worker_id: workerId,
          started_at: agora,
          last_heartbeat_at: agora,
        },
        $inc: {
          attempt: 1,
        },
      },
      {
        new: true,
        runValidators: true,
      }
    );

    if (reclamado) {
      console.log(
        `[VIDEO CLAIM] Processamento reclamado: ${messageId}`
      );

      return res.status(200).json({
        messageId,
        workerId,
        claimed: true,
        status: "processing",
        attempt: reclamado.attempt,
      });
    }

    //AB Distinguir duplicados de processamentos inexistentes.
    const existente = await VideoProcess.findOne({
      msg_id: messageId,
    });

    if (!existente) {
      return res.status(404).json({
        message: "Processamento não encontrado.",
      });
    }

    //AB Uma execução já reclamada ou terminada não pode ser reclamada novamente.
    return res.status(200).json({
      messageId,
      claimed: false,
      status: existente.status,
    });
  } catch (erro) {
    console.error(
      "[VIDEO CLAIM] Erro ao reclamar processamento:",
      erro.message
    );

    return res.status(503).json({
      message: "Não foi possível reclamar o processamento.",
    });
  }
});

module.exports = router;