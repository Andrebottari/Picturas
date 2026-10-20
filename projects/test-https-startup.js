const assert = require("node:assert/strict");
const fs = require("node:fs");
const https = require("node:https");

const key = fs.readFileSync(process.env.PROJECTS_TLS_KEY_FILE);
const cert = fs.readFileSync(process.env.PROJECTS_TLS_CERT_FILE);

const servidor = https.createServer(
  { key, cert },
  (req, res) => {
    res.writeHead(200, {
      "Content-Type": "application/json",
    });

    res.end(JSON.stringify({
      status: "ok",
      service: "projects",
    }));
  }
);

servidor.listen(0, "0.0.0.0", async () => {
  const porta = servidor.address().port;

  try {
    const resposta = await fetch(
      `https://projects:${porta}`,
      {
        dispatcher: undefined,
      }
    );

    assert.equal(resposta.status, 200);

    console.log("SUCESSO — Servidor HTTPS iniciado.");
  } catch (erro) {
    console.error("FALHA:", erro.message);
    process.exitCode = 1;
  } finally {
    servidor.close();
  }
});