// UC-03: autorização de edição do vídeo original, validada no servidor.
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const Project = require("../controllers/project");

async function requireVideoEditor(req, res, next) {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Autenticação necessária." });
  }
  if (!process.env.JWT_SECRET_KEY) return res.status(503).json({ message: "Autenticação indisponível." });
  let payload;
  try { payload = jwt.verify(header.slice(7), process.env.JWT_SECRET_KEY); }
  catch (_) { return res.status(401).json({ message: "Token inválido ou expirado." }); }
  const actorId = payload && payload.id;
  const { user: ownerId, project: projectId } = req.params;
  if (![actorId, ownerId, projectId].every(id => typeof id === "string" && mongoose.isObjectIdOrHexString(id))) {
    return res.status(400).json({ message: "Identificadores inválidos." });
  }
  try {
    const project = await Project.getOne(ownerId, projectId);
    if (!project) return res.status(404).json({ message: "Projeto não encontrado." });
    const isOwner = String(actorId) === String(ownerId);
    if (!isOwner) {
      const shareId = req.query.share;
      if (typeof shareId !== "string" || !shareId) {
        return res.status(403).json({ message: "Partilha de edição necessária." });
      }
      const linked = await Project.getOneByShareId(shareId);
      if (!linked || String(linked._id) !== String(projectId) || String(linked.user_id) !== String(ownerId)) {
        return res.status(404).json({ message: "Partilha não encontrada." });
      }
      const link = (linked.sharedLinks || []).find(x => x.id === shareId);
      if (!link || link.revoked) return res.status(410).json({ message: "Partilha revogada." });
      if (link.permission !== "edit") return res.status(403).json({ message: "A partilha permite apenas leitura." });
    }
    req.videoAuthenticatedUserId = actorId;
    req.videoProject = project;
    req.videoGuestEditor = !isOwner;
    return next();
  } catch (error) {
    console.error("[VIDEO EDIT SHARE] Erro:", error.message);
    return res.status(503).json({ message: "Não foi possível verificar a autorização." });
  }
}
module.exports = { requireVideoEditor };
