const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const VideoProcess = require("./models/videoProcess");
const videoStorage = require("./utils/videoStorage");

let falhaArmazenamento = false;
let falhaMongo = false;
let eventos = [];
let processoAtual;

VideoProcess.findOne = async () => processoAtual;

VideoProcess.findOneAndUpdate = async (filtro, alteracao) => {
  eventos.push("mongo");

  if (falhaMongo) {
    throw new Error("Falha MongoDB simulada");
  }

  return {
    ...processoAtual,
    ...alteracao.$set,
  };
};

videoStorage.postVideo = async () => {
  eventos.push("storage");

  if (falhaArmazenamento) {
    throw new Error("Falha SeaweedFS simulada");
  }

  return {
    data: {
      videoKey: `${processoAtual.project_id}/out/teste.mp4`,
    },
  };
};

const { tratarResultadoVideo } = require("./utils/video_results");

async function testar(cenario) {
  const id = randomUUID();

  const diretorio = path.join(
    "/app/images/video-filters",
    id
  );

  const entrada = path.join(diretorio, "input.mp4");
  const saida = path.join(diretorio, "output.mp4");

  await fs.mkdir(diretorio, { recursive: true });

  await fs.writeFile(entrada, "video-original-simulado");
  await fs.writeFile(saida, "video-processado-simulado");

  processoAtual = {
    _id: "507f1f77bcf86cd799439013",
    user_id: "507f1f77bcf86cd799439011",
    project_id: "507f1f77bcf86cd799439012",
    msg_id: id,
    status: "pending",
  };

  falhaArmazenamento = cenario === "storage";
  falhaMongo = cenario === "mongo";
  eventos = [];

  try {
    const execucao = tratarResultadoVideo({
      correlationId: id,
      status: "success",
      output: {
        type: "video",
        videoURI: saida,
      },
    });

    if (cenario === "sucesso") {
      await execucao;

      assert.deepEqual(eventos, ["storage", "mongo"]);

      await assert.rejects(
        fs.stat(diretorio),
        { code: "ENOENT" }
      );

      console.log(
        "OK 1 — Conclusão persistida antes da limpeza."
      );
    } else {
      await assert.rejects(execucao);

      const estado = await fs.stat(saida);

      assert.ok(estado.isFile());

      console.log(
        cenario === "storage"
          ? "OK 2 — Falha no armazenamento preserva os ficheiros."
          : "OK 3 — Falha MongoDB preserva os ficheiros."
      );
    }
  } finally {
    await fs.rm(diretorio, {
      recursive: true,
      force: true,
    });
  }
}

async function executar() {
  await testar("sucesso");
  await testar("storage");
  await testar("mongo");

  console.log(
    "\nSUCESSO — Integração da limpeza validada."
  );
}

executar().catch((erro) => {
  console.error("FALHA:", erro.message);
  process.exitCode = 1;
});