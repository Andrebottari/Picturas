import json
import os
import time
import uuid
from datetime import datetime, timezone

import pika

from video_filters import aplicar_filtros


RABBITMQ_HOST = os.getenv("RABBITMQ_HOST", "rabbitmq")
RABBITMQ_PORT = int(os.getenv("RABBITMQ_PORT", "5672"))
RABBITMQ_USER = os.getenv("RABBITMQ_USER", "user")
RABBITMQ_PASS = os.getenv("RABBITMQ_PASS", "password")

REQUEST_QUEUE = "video_filters_queue"
RESULT_EXCHANGE = "picturas"
RESULT_ROUTING_KEY = "project_queue"


def converter_filtros(filtros):
    resultado = []

    if not isinstance(filtros, list) or not filtros:
        raise ValueError("É necessário indicar pelo menos um filtro.")

    for filtro in filtros:
        if not isinstance(filtro, dict):
            raise ValueError("Cada filtro deve ser um objeto.")

        nome = filtro.get("name")

        if not isinstance(nome, str) or not nome:
            raise ValueError("Cada filtro deve ter um nome válido.")

        valor = filtro.get("value")

        if valor is None:
            resultado.append(nome)
        else:
            resultado.append(f"{nome}:{valor}")

    return resultado


def resposta_sucesso(message_id, output_uri, tempo_ms):
    return {
        "messageId": str(uuid.uuid4()),
        "correlationId": message_id,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "status": "success",
        "output": {
            "type": "video",
            "videoURI": output_uri
        },
        "metadata": {
            "processingTime": tempo_ms,
            "microservice": "picturas-video-filters-tool-ms"
        }
    }


def resposta_erro(message_id, mensagem, tempo_ms):
    return {
        "messageId": str(uuid.uuid4()),
        "correlationId": message_id,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "status": "error",
        "error": {
            "code": 2901,
            "message": mensagem
        },
        "metadata": {
            "processingTime": tempo_ms,
            "microservice": "picturas-video-filters-tool-ms"
        }
    }


def processar_pedido(mensagem):
    inicio = time.monotonic()

    message_id = mensagem["messageId"]

    try:
        if mensagem.get("procedure") != "video_filters":
            raise ValueError("Procedimento não suportado.")

        parametros = mensagem["parameters"]

        filtros = converter_filtros(parametros["filters"])

        aplicar_filtros(
            parametros["inputVideoURI"],
            parametros["outputVideoURI"],
            filtros
        )

        tempo_ms = round((time.monotonic() - inicio) * 1000)

        return resposta_sucesso(
            message_id,
            parametros["outputVideoURI"],
            tempo_ms
        )

    except Exception as erro:
        tempo_ms = round((time.monotonic() - inicio) * 1000)

        return resposta_erro(
            message_id,
            str(erro),
            tempo_ms
        )


def executar_worker():
    credenciais = pika.PlainCredentials(
        RABBITMQ_USER,
        RABBITMQ_PASS
    )

    parametros = pika.ConnectionParameters(
        host=RABBITMQ_HOST,
        port=RABBITMQ_PORT,
        credentials=credenciais,
        heartbeat=600,
        blocked_connection_timeout=300
    )

    while True:
        try:
            ligacao = pika.BlockingConnection(parametros)
            canal = ligacao.channel()

            canal.exchange_declare(
                exchange=RESULT_EXCHANGE,
                exchange_type="direct",
                durable=True
            )

            canal.queue_declare(
                queue=REQUEST_QUEUE,
                durable=True
            )

            canal.basic_qos(prefetch_count=1)

            def callback(ch, method, properties, body):
                try:
                    mensagem = json.loads(body)
                    resposta = processar_pedido(mensagem)
                except Exception as erro:
                    resposta = resposta_erro(
                        "desconhecido",
                        str(erro),
                        0
                    )

                ch.basic_publish(
                    exchange=RESULT_EXCHANGE,
                    routing_key=RESULT_ROUTING_KEY,
                    body=json.dumps(resposta),
                    properties=pika.BasicProperties(
                        delivery_mode=2
                    )
                )

                ch.basic_ack(delivery_tag=method.delivery_tag)

                print(
                    f"[video_filters] {resposta['status']}",
                    flush=True
                )

            canal.basic_consume(
                queue=REQUEST_QUEUE,
                on_message_callback=callback,
                auto_ack=False
            )

            print(
                "[video_filters] À espera de pedidos...",
                flush=True
            )

            canal.start_consuming()

        except pika.exceptions.AMQPConnectionError as erro:
            print(
                f"[video_filters] RabbitMQ indisponível: {erro}",
                flush=True
            )
            time.sleep(5)


if __name__ == "__main__":
    executar_worker()