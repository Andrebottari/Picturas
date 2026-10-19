const fs = require("node:fs/promises");
const path = require("node:path");

const BASE_DIR = "/app/images/video-filters";

//AB Remover os ficheiros temporários de uma execução de vídeo.
async function limparFicheirosVideo(outputVideoURI) {
  if (typeof outputVideoURI !== "string") {
    throw new Error("Caminho de vídeo inválido.");
  }

  const diretorio = path.dirname(outputVideoURI);

  //AB Aceitar apenas diretórios de execução imediatamente abaixo da base.
  if (
    path.dirname(diretorio) !== BASE_DIR ||
    !/^[a-f0-9-]{36}$/i.test(path.basename(diretorio)) ||
    path.basename(outputVideoURI) !== "output.mp4"
  ) {
    throw new Error("Caminho fora da área temporária de vídeos.");
  }

  await fs.rm(diretorio, {
    recursive: true,
    force: true,
  });
}

module.exports = {
  limparFicheirosVideo,
};
