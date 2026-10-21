const express = require("express");

const uploadRoutes = require("./route/upload");
const imageRoutes = require("./route/images");
const deleteRoutes = require("./route/delete");
const copyRoutes = require("./route/copy");
const videoDeleteRoutes = require("./route/videoDelete");
const videoRoutes = require("./route/videos");
const videoSourceRoutes = require("./route/videoSource");
const videoOutputRoutes = require("./route/videoOutput");

const app = express();

app.use("/upload", uploadRoutes);
app.use("/image", imageRoutes);
app.use("/delete", deleteRoutes);
app.use("/copy", copyRoutes);

//AB Operações internas de vídeo.
app.use("/video", videoRoutes);
app.use("/video-result", videoDeleteRoutes);
app.use("/video-source", videoSourceRoutes);
//AB Resultado final só é acessível por credencial interna.
app.use("/video-output", videoOutputRoutes);

//AB Porta utilizada pelo serviço de armazenamento no Docker.
const PORT = Number(process.env.PORT || 11000);

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});