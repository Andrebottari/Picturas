const axios = require("axios");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { pipeline } = require("node:stream/promises");

//AB Obter o original através do serviço interno de armazenamento.
async function descarregarVideoOriginal(
  userId,
  projectId,
  videoKey,
  processId
) {
  const objectIdRegex = /^[a-f0-9]{24}$/i;

  const originalRegex =
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.mp4$/i;

  if (
    !objectIdRegex.test(userId) ||
    !objectIdRegex.test(projectId)
  ) {
    throw new Error("Identificadores de utilizador ou projeto inválidos.");
  }

  const prefixo = `${projectId}/src/`;

  if (
    typeof videoKey !== "string" ||
    !videoKey.startsWith(prefixo)
  ) {
    throw new Error("Chave do vídeo original inválida.");
  }

  const fileName = videoKey.slice(prefixo.length);

  if (!originalRegex.test(fileName)) {
    throw new Error("Nome do vídeo original inválido.");
  }

  //AB Validar o identificador antes de construir caminhos locais.
  if (
    typeof processId !== "string" ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(processId)
  ) {
    throw new Error("Identificador de processamento inválido.");
  }

  const segredo = process.env.VIDEO_INTERNAL_SECRET;

  if (!segredo) {
    throw new Error("VIDEO_INTERNAL_SECRET não configurado.");
  }

  const baseURL =
    process.env.VIDEO_STORAGE_URL || "http://img_storage:11000";

  // Diretório privado de cada processamento no volume partilhado.
  const diretorio = path.join(
    "/app/images",
    "video-filters",
    processId
  );

  const destino = path.join(diretorio, "input.mp4");

  await fsp.mkdir(diretorio, { recursive: true });

  try {
    const resposta = await axios.get(
      `${baseURL}/video-source/` +
        `${userId}/${projectId}/${fileName}`,
      {
        responseType: "stream",
        headers: {
          "X-Video-Internal-Secret": segredo,
        },
        timeout: 120000,
        maxRedirects: 0,
      }
    );

    //AB pipeline aguarda a escrita completa e propaga erros de stream.
    await pipeline(
      resposta.data,
      fs.createWriteStream(destino, { flags: "wx" })
    );

    const estado = await fsp.stat(destino);

    if (!estado.isFile() || estado.size === 0) {
      throw new Error("O vídeo descarregado está vazio.");
    }

    return {
      inputVideoURI: destino,
      outputVideoURI: path.join(diretorio, "output.mp4"),
    };
  } catch (erro) {
    //AB Nunca deixar um MP4 parcial disponível ao worker.
    await fsp.rm(diretorio, {
      recursive: true,
      force: true,
    });

    throw erro;
  }
}

module.exports = {
  descarregarVideoOriginal,
};