// Protege acessos normais e partilhados aos recursos do projeto.
const Project = require("../controllers/project");
const { getCallerId } = require("../utils/caller");

async function checkSharePermission(req, res, next) {
  try {
    const auth = req.headers.authorization;
    const caller = getCallerId(req);
    if (!auth || !auth.startsWith("Bearer ") || !caller) {
      return res.status(401).jsonp("Authentication required");
    }

    const owner = req.params.user;
    const shareId = req.query.share;
    if (!shareId) {
      if (String(caller) !== String(owner)) {
        return res.status(403).jsonp("Not allowed");
      }
      return next();
    }

    const project = await Project.getOneByShareId(shareId);
    if (!project) return res.status(404).jsonp("Share link not found");
    const link = (project.sharedLinks || []).find((l) => l.id === shareId);
    if (!link || link.revoked) return res.status(410).jsonp("Share link unavailable");
    if (owner && String(owner) !== String(project.user_id)) {
      return res.status(403).jsonp("Share link does not match this project owner");
    }
    if (req.params.project && String(req.params.project) !== String(project._id)) {
      return res.status(403).jsonp("Share link does not match this project");
    }
    req.sharedProject = project;
    req.sharedPermission = link.permission;
    return next();
  } catch (e) {
    console.error("Share permission check failed:", e.message);
    return res.status(500).jsonp("Error checking project permissions");
  }
}

function requireEditPermission(req, res, next) {
  if (!req.sharedPermission || req.sharedPermission === "edit") return next();
  return res.status(403).jsonp("Share link has no edit permission");
}

module.exports = { checkSharePermission, requireEditPermission };
