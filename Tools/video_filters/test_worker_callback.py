"""Teste isolado do callback RabbitMQ do worker UC-03.

Nao inicia RabbitMQ, FFmpeg, MongoDB ou os servicos principais.
Executar num contentor com pika instalada e worker.py/video_filters.py montados.
"""
import json
from types import SimpleNamespace
from unittest.mock import patch

import worker


class FimDoTeste(BaseException):
    """Interrompe o ciclo infinito do worker depois de uma entrega simulada."""


class CanalFalso:
    def __init__(self, modo):
        self.modo = modo
        self.confirmado = False
        self.publicacoes = []
        self.acks = []
        self.nacks = []
        self.rejeicoes = []
        self.callback = None

    def exchange_declare(self, **kwargs):
        pass

    def queue_declare(self, **kwargs):
        pass

    def queue_bind(self, **kwargs):
        pass

    def basic_qos(self, **kwargs):
        pass

    def confirm_delivery(self):
        self.confirmado = True

    def basic_consume(self, **kwargs):
        self.callback = kwargs["on_message_callback"]

    def basic_publish(self, **kwargs):
        assert self.confirmado, "Publisher Confirms nao foi ativado"
        assert kwargs["mandatory"] is True
        assert kwargs["properties"].delivery_mode == 2
        self.publicacoes.append(kwargs)
        if self.modo == "falha_publicacao":
            raise RuntimeError("Falha simulada na publicacao")
        # Pika BlockingChannel pode devolver None em caso de sucesso.
        return None

    def basic_ack(self, *, delivery_tag):
        self.acks.append(delivery_tag)

    def basic_nack(self, *, delivery_tag, requeue):
        self.nacks.append((delivery_tag, requeue))

    def basic_reject(self, *, delivery_tag, requeue):
        self.rejeicoes.append((delivery_tag, requeue))

    def start_consuming(self):
        assert self.callback is not None
        self.callback(
            self,
            SimpleNamespace(delivery_tag=42),
            None,
            json.dumps({"messageId": "teste-uc03", "procedure": "video_filters"}).encode(),
        )
        raise FimDoTeste


class LigacaoFalsa:
    def __init__(self, canal):
        self.canal = canal
        self.is_open = True

    def channel(self):
        return self.canal

    def close(self):
        self.is_open = False


def verificar(modo, autorizado, acks_esperados, publicacoes_esperadas):
    canal = CanalFalso(modo)
    ligacao = LigacaoFalsa(canal)
    executou = []

    def processamento(mensagem):
        executou.append(mensagem["messageId"])
        return {"status": "success", "correlationId": mensagem["messageId"]}

    with (
        patch.object(worker.pika, "BlockingConnection", return_value=ligacao),
        patch.object(worker, "reclamar_processamento", return_value=autorizado),
        patch.object(worker, "processar_pedido", side_effect=processamento),
        patch.object(worker, "manter_heartbeat", return_value=None),
        patch.object(worker.time, "sleep", side_effect=FimDoTeste),
    ):
        try:
            worker.executar_worker()
        except FimDoTeste:
            pass

    assert canal.confirmado
    assert canal.acks == acks_esperados, f"ACK inesperado: {canal.acks}"
    assert len(canal.publicacoes) == publicacoes_esperadas
    assert len(executou) == (1 if autorizado else 0)
    assert not canal.nacks
    assert not canal.rejeicoes


if __name__ == "__main__":
    verificar("sucesso", True, [42], 1)
    print("OK 1 — Publicacao confirmada: exatamente um ACK.")

    verificar("falha_publicacao", True, [], 1)
    print("OK 2 — Falha de publicacao: nenhum ACK.")

    verificar("duplicado", False, [42], 0)
    print("OK 3 — Mensagem duplicada: ACK sem executar FFmpeg.")

    print("\nSUCESSO — Callback do worker validado com canal simulado.")
