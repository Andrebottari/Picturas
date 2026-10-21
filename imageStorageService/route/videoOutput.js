//AB UC-03: leitura interna autenticada de resultados MP4, sem URLs S3 públicas.
const express = require("express");
const s3 = require("../services/s3Client");
const { requireVideoInternalAuth } = require("../middleware/videoInternalAuth");
const router = express.Router();

router.get("/:userId/:projectId/:fileName", requireVideoInternalAuth, async (req, res) => {
  const { userId, projectId, fileName } = req.params;
  if (!/^[a-f0-9]{24}$/i.test(userId) || !/^[a-f0-9]{24}$/i.test(projectId) ||
      !/^[a-f0-9]{64}\.mp4$/.test(fileName)) {
    return res.status(400).json({ message: "Identificadores de resultado inválidos." });
  }
  const location = { Bucket: `user-${userId}`, Key: `${projectId}/out/${fileName}` };
  try {
    //AB Confirmar que o objeto existe ANTES de transmitir cabeçalhos ao cliente.
    const head = await s3.headObject(location).promise();
    res.set({
      "Content-Type": "video/mp4", "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      ...(Number.isSafeInteger(head.ContentLength) ? { "Content-Length": String(head.ContentLength) } : {}),
    });
    const stream = s3.getObject(location).createReadStream();
    stream.on("error", (error) => {
      console.error("[VIDEO OUTPUT] Erro no stream:", error.code || error.message);
      res.destroy(error);
    });
    stream.pipe(res);
  } catch (error) {
    const notFound = error.code === "NoSuchKey" || error.code === "NoSuchBucket" ||
      error.code === "NotFound" || error.statusCode === 404;
    console.error("[VIDEO OUTPUT] Erro de leitura:", error.code || error.message);
    return res.status(notFound ? 404 : 502).json({
      message: notFound ? "Resultado MP4 não encontrado." : "Falha ao ler resultado MP4.",
    });
  }
});
module.exports = router;
