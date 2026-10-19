const fs = require("node:fs");
const path = require("node:path");
const { randomUUID, createHash } = require("node:crypto");

const s3 = require("./s3Client");
const createBucket = require("./createBucket");

//AB Guardar um vídeo MP4 já validado no SeaweedFS.
async function uploadVideo(userId, projectId, filePath, stage, processId = null) {
  if (!["src", "out"].includes(stage)) {
    throw new Error("Estágio de vídeo inválido.");
  }

  if (!userId || !projectId) {
    throw new Error("Utilizador ou projeto inválido.");
  }

  if (!filePath || typeof filePath !== "string") {
    throw new Error("Caminho do vídeo inválido.");
  }

const bucketName = `user-${userId}`;

if (processId !== null && (
  stage !== "out" ||
  typeof processId !== "string" ||
  processId.length === 0 ||
  processId.length > 256
)) {
  throw new Error("Identificador de processamento inválido.");
}

//AB Resultados do mesmo processamento utilizam a mesma chave.
// Vídeos originais continuam a utilizar UUID.
const identificador = processId === null
  ? randomUUID()
  : createHash("sha256").update(processId).digest("hex");

const videoKey = `${projectId}/${stage}/${identificador}.mp4`;

  //AB Reutilizar o mecanismo de buckets do PictuRAS.
  await createBucket(bucketName);

  //AB Transferir o ficheiro por stream, sem o carregar
  // integralmente para a memória do Node.js.
  const stream = fs.createReadStream(filePath);

  try {
    const resultado = await s3.upload({
      Bucket: bucketName,
      Key: videoKey,
      Body: stream,
      ContentType: "video/mp4",
    }).promise();

    return {
      videoKey,
      location: resultado.Location,
    };
  } catch (erro) {
    console.error("[VIDEO STORAGE] Falha ao guardar vídeo:", erro.message);
    throw erro;
  } finally {
    stream.destroy();
  }
}

module.exports = uploadVideo;