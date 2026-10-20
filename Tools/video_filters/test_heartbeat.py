import json
import os
import ssl
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

import worker


class ServidorTeste(BaseHTTPRequestHandler):
    pedidos = []

    def do_POST(self):
        tamanho = int(self.headers.get("Content-Length", "0"))
        corpo = json.loads(self.rfile.read(tamanho))

        assert self.path == "/internal/video/heartbeat"
        assert corpo["messageId"] == "teste-heartbeat-123"
        assert corpo["workerId"] == worker.WORKER_ID

        self.pedidos.append(corpo)

        resposta = json.dumps({
            "messageId": corpo["messageId"],
            "workerId": corpo["workerId"],
            "active": True,
            "status": "processing"
        }).encode("utf-8")

        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(resposta)))
        self.end_headers()
        self.wfile.write(resposta)

    def log_message(self, *_):
        pass


def executar():
    servidor = HTTPServer(
        ("0.0.0.0", 9001),
        ServidorTeste
    )

    contexto = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    contexto.load_cert_chain(
        "/certs/projects.crt",
        "/certs/projects.key"
    )

    servidor.socket = contexto.wrap_socket(
        servidor.socket,
        server_side=True
    )

    thread_servidor = threading.Thread(
        target=servidor.serve_forever,
        daemon=True
    )

    thread_servidor.start()

    worker.VIDEO_CLAIM_URL = (
        "https://projects:9001/internal/video/claim"
    )
    worker.VIDEO_PROJECTS_CA_FILE = "/certs/projects.crt"
    worker.VIDEO_INTERNAL_SECRET = "segredo-teste-heartbeat"
    worker.VIDEO_HEARTBEAT_INTERVAL = 0.3

    parar = threading.Event()

    thread = threading.Thread(
        target=worker.manter_heartbeat,
        args=("teste-heartbeat-123", parar),
        daemon=True
    )

    try:
        thread.start()
        time.sleep(1.2)

        assert len(ServidorTeste.pedidos) >= 2, (
            "Não foram recebidos heartbeats suficientes."
        )

        print(
            "OK 1 — Heartbeats enviados durante o processamento."
        )

        quantidade_antes = len(ServidorTeste.pedidos)

        parar.set()
        thread.join(timeout=3)

        assert not thread.is_alive(), (
            "A thread de heartbeat não terminou."
        )

        print("OK 2 — Thread terminou corretamente.")

        time.sleep(0.7)

        assert len(ServidorTeste.pedidos) == quantidade_antes, (
            "Foram enviados heartbeats após a paragem."
        )

        print("OK 3 — Nenhum heartbeat após a paragem.")

        print("\nSUCESSO — Heartbeat periódico validado.")

    finally:
        parar.set()
        thread.join(timeout=3)
        servidor.shutdown()
        servidor.server_close()


if __name__ == "__main__":
    executar()