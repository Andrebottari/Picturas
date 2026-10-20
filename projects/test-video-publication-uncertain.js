const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");

const Project = require("./controllers/project");
const VideoProcess = require("./models/videoProcess");
const videoSource = require("./utils/videoSource");
const videoQueue = require("./utils/videoQueue");

const userId = "507f1f77bcf86cd799439011";
const projectId = "507f1f77bcf86cd799439012";

process.env.JWT_SECRET_KEY = "segredo-ficticio-uc03-incerto";

let processoGuardado = null;
let publicacaoIniciada = false;
let marcouComoFailed = false;

// Projeto autorizado simulado.
Project.getOne = async () => ({
  _id: projectId,
  user_id: userId,
  version: 3,
  video: {
    original_key:
      `${projectId}/src/12345678-1234-4234-8234-123456789abc.mp4`,
  },
});

// Simular exclusivamente a persistência inicial.
VideoProcess.prototype.save = async function () {
  processoGuardado = this;
  return this;
};

// Detetar uma atualização indevida para failed.
VideoProcess.findOneAndUpdate = async () => {
  marcouComoFailed = true;
  throw new Error("O estado não deveria ser alterado.");
};

// O descarregamento termina com sucesso.
videoSource.descarregarVideoOriginal = async () => ({
  inputVideoURI: "/app/images/video-filters/teste/input.mp4",
  outputVideoURI: "/app/images/video-filters/teste/output.mp4",
});

// Simular perda da confirmação RabbitMQ.
videoQueue.publicarProcessamentoVideo = async () => {
  publicacaoIniciada = true;
  throw new Error("Ligação RabbitMQ interrompida.");
};

// Importar a rota depois das simulações.
const routes = require("./routes/videos");

const app = express();
app.use(express.json());
app.use("/", routes);

async function executar() {
  const servidor = app.listen(0, "127.0.0.1");

  await new Promise((resolve) =>
    servidor.once("listening", resolve)
  );

  try {
    const token = jwt.sign(
      { id: userId },
      process.env.JWT_SECRET_KEY,
      { expiresIn: "5m" }
    );

    const resposta = await fetch(
      `http://127.0.0.1:${servidor.address().port}` +
        `/${userId}/${projectId}/video/process`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Project-Version": "3",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          filters: [{ name: "cinzento" }],
        }),
      }
    );

    const dados = await resposta.json();

    assert.equal(resposta.status, 503);
    assert.equal(publicacaoIniciada, true);
    assert.ok(processoGuardado);

    assert.equal(
      dados.processId,
      String(processoGuardado._id)
    );

    assert.equal(
      dados.messageId,
      processoGuardado.msg_id
    );

    assert.equal(dados.publicationUncertain, true);
    assert.equal(dados.status, "pending");
    assert.equal(marcouComoFailed, false);

    console.log("OK 1 — HTTP 503 devolvido.");
    console.log("OK 2 — Identificadores preservados.");
    console.log("OK 3 — Publicação assinalada como incerta.");
    console.log("OK 4 — Processamento não marcado como failed.");
    console.log(
      "\nSUCESSO — Publicação incerta tratada corretamente."
    );
  } finally {
    await new Promise((resolve) =>
      servidor.close(resolve)
    );
  }
}

executar().catch((erro) => {
  console.error("FALHA:", erro.message);
  process.exitCode = 1;
});