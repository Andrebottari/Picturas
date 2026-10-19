const multer = require("multer");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

//AB Configuração de carregamento temporário exclusiva dos vídeos.
const videoUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, os.tmpdir());
    },

    filename: (req, file, cb) => {
      cb(null, `picturas-project-video-${crypto.randomUUID()}.tmp`);
    },
  }),

  // Limite técnico inicial de 500 MB.
  // Os limites por perfil serão aplicados posteriormente.
  limits: {
    fileSize: 500 * 1024 * 1024,
    files: 1,
  },

  // Verificar o tipo declarado antes de aceitar o ficheiro.
  // A validação real do conteúdo será realizada com FFprobe.
  fileFilter: (req, file, cb) => {
    if (
      file.mimetype !== "video/mp4" ||
      path.extname(file.originalname).toLowerCase() !== ".mp4"
    ) {
      return cb(new Error("Apenas ficheiros MP4 são permitidos."));
    }

    cb(null, true);
  },
});

module.exports = { videoUpload };