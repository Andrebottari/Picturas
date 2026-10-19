const axios = require("axios");
const FormData = require("form-data");
const fs = require("node:fs");
const path = require("node:path");

//AB Permitir um servidor de armazenamento isolado durante os testes.
const VIDEO_STORAGE_URL =
  process.env.VIDEO_STORAGE_URL || "http://img_storage:11000";

//Enviar vídeos MP4 por stream para o serviço de armazenamento.
//Permitir armazenar vídeos originais e resultados processados.
async function postVideo(
  userId,
  projectId,
  filePath,
  originalName,
  stage = "src",
  processId = null
) {
  if (!userId || !projectId) {
    throw new Error("Utilizador ou projeto inválido.");
  }

  if (!filePath || typeof filePath !== "string") {
    throw new Error("Caminho do vídeo inválido.");
  }
  // Validar o destino do ficheiro no armazenamento.
  if (!["src", "out"].includes(stage)) {
  throw new Error("Estágio de vídeo inválido.");
  }

    // Identificadores de processamento só são aceites em resultados.
  if (
    processId !== null &&
    (
      stage !== "out" ||
      typeof processId !== "string" ||
      processId.length === 0 ||
      processId.length > 256
    )
  ) {
    throw new Error("Identificador de processamento inválido.");
  }
  // Exigir autenticação interna antes de iniciar a transferência.
  const segredoInterno = process.env.VIDEO_INTERNAL_SECRET;

  if (!segredoInterno) {
    throw new Error("VIDEO_INTERNAL_SECRET não configurado.");
  }

  const data = new FormData();

  data.append("file", fs.createReadStream(filePath), {
    filename: originalName || path.basename(filePath),
    contentType: "video/mp4",
  });

  // Enviar a credencial apenas ao serviço interno de armazenamento.
  const resposta = await axios.post(
    `${VIDEO_STORAGE_URL}/video/${userId}/${projectId}/${stage}`,
    data,
    {
      headers: {
        ...data.getHeaders(),
        "X-Video-Internal-Secret": segredoInterno,
         ...(processId !== null
         ? { "X-Video-Process-Id": processId }
        : {}),
    },
      maxBodyLength: 500 * 1024 * 1024,
      maxContentLength: 10 * 1024 * 1024,
      timeout: 120000,
    }
  );

  return resposta.data;
}

//AB Solicitar a eliminação autenticada de um resultado de vídeo.
async function deleteVideoResult(userId, projectId, videoKey) {
  if (!userId || !projectId) {
    throw new Error("Utilizador ou projeto inválido.");
  }

  const segredoInterno = process.env.VIDEO_INTERNAL_SECRET;

  if (!segredoInterno) {
    throw new Error("VIDEO_INTERNAL_SECRET não configurado.");
  }

  // Aceitar apenas a chave de um resultado do projeto indicado.
  const prefixo = `${projectId}/out/`;

  if (
    typeof videoKey !== "string" ||
    !videoKey.startsWith(prefixo)
  ) {
    throw new Error("Chave do resultado de vídeo inválida.");
  }

  const fileName = videoKey.slice(prefixo.length);

  // Os resultados utilizam o hash SHA-256 do msg_id.
  if (!/^[a-f0-9]{64}\.mp4$/.test(fileName)) {
    throw new Error("Nome do resultado de vídeo inválido.");
  }

  const resposta = await axios.delete(
    `${VIDEO_STORAGE_URL}/video-result/${encodeURIComponent(userId)}/${encodeURIComponent(projectId)}/${encodeURIComponent(fileName)}`,
    {
      headers: {
        "X-Video-Internal-Secret": segredoInterno,
      },
      timeout: 30000,
    }
  );

  return resposta.data;
}


module.exports = {
  postVideo,
  deleteVideoResult,
};