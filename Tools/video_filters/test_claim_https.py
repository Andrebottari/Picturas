import importlib.util
import json
import os
import ssl
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from unittest.mock import patch
from urllib import error
from uuid import uuid4


CERT = "/certs/projects.crt"
KEY = "/certs/projects.key"
SEGREDO = "segredo-ficticio-uc03-https"
MESSAGE_ID = str(uuid4())


class ServidorTeste(BaseHTTPRequestHandler):
    def do_POST(self):
        assert self.path == "/internal/video/claim"

        #AB Simular o comportamento real da autenticação em projects.
        if self.headers.get("X-Video-Internal-Secret") != SEGREDO:
            corpo = json.dumps({
                "message": "Acesso interno não autorizado."
            }).encode("utf-8")

            self.send_response(401)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(corpo)))
            self.end_headers()
            self.wfile.write(corpo)
            return

        tamanho = int(self.headers["Content-Length"])
        dados = json.loads(self.rfile.read(tamanho))

        assert dados["messageId"] == MESSAGE_ID

        resposta = {
            "messageId": MESSAGE_ID,
            "claimed": self.server.autorizar,
            "status": "processing",
            "workerId": os.environ.get("VIDEO_WORKER_ID") or __import__("socket").gethostname(),
        }

        corpo = json.dumps(resposta).encode()

        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(corpo)))
        self.end_headers()
        self.wfile.write(corpo)

    def log_message(self, formato, *argumentos):
        pass


def executar():
    servidor = HTTPServer(("0.0.0.0", 0), ServidorTeste)

    contexto = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    contexto.load_cert_chain(CERT, KEY)

    servidor.socket = contexto.wrap_socket(
        servidor.socket,
        server_side=True,
    )

    servidor.autorizar = True

    thread = threading.Thread(
        target=servidor.serve_forever,
        daemon=True,
    )
    thread.start()

    os.environ["VIDEO_INTERNAL_SECRET"] = SEGREDO
    os.environ["VIDEO_PROJECTS_CA_FILE"] = CERT
    os.environ["VIDEO_CLAIM_URL"] = (
        f"https://projects:{servidor.server_port}/internal/video/claim"
    )

    # Carregar o worker real sem iniciar o consumo RabbitMQ.
    spec = importlib.util.spec_from_file_location(
        "worker",
        "/app/worker.py",
    )

    worker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(worker)

    try:
        # O nome projects deverá resolver para 127.0.0.1.
        assert worker.reclamar_processamento(MESSAGE_ID) is True
        print("OK 1 — Ligação HTTPS e reclamação autorizada.")

        servidor.autorizar = False

        assert worker.reclamar_processamento(MESSAGE_ID) is False
        print("OK 2 — Reclamação duplicada recusada.")

        with patch.object(worker, "VIDEO_INTERNAL_SECRET", "segredo-errado"):
            try:
                worker.reclamar_processamento(MESSAGE_ID)
                raise AssertionError("Pedido inválido foi aceite.")
            except RuntimeError:
                print("OK 3 — Falha de autenticação não autoriza execução.")

        with patch.object(worker, "VIDEO_CLAIM_URL", "https://projects:1/internal/video/claim"):
            try:
                worker.reclamar_processamento(MESSAGE_ID)
                raise AssertionError("Ligação indisponível foi aceite.")
            except Exception:
                print("OK 4 — Falha de comunicação não autoriza execução.")

        print("\nSUCESSO — Comunicação HTTPS do worker validada.")

    finally:
        servidor.shutdown()
        servidor.server_close()


if __name__ == "__main__":
    executar()