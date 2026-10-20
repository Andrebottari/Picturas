import json
import os
import time
import uuid
import ssl
import socket
import threading
from urllib import request, error
from datetime import datetime, timezone

import pika

from video_filters import aplicar_filtros


RABBITMQ_HOST = os.getenv("RABBITMQ_HOST", "rabbitmq")
RABBITMQ_PORT = int(os.getenv("RABBITMQ_PORT", "5672"))
RABBITMQ_USER = os.getenv("RABBITMQ_USER", "user")
RABBITMQ_PASS = os.getenv("RABBITMQ_PASS", "password")

REQUEST_QUEUE = "video_filters_queue"
RESULT_EXCHANGE = "picturas"
RESULT_ROUTING_KEY = "video_results_queue"

#AB Endpoint interno para reclamar processamentos antes de executar FFmpeg.
VIDEO_CLAIM_URL = os.getenv(
    "VIDEO_CLAIM_URL",
    "https://projects:9001/internal/video/claim"
)

VIDEO_INTERNAL_SECRET = os.getenv("VIDEO_INTERNAL_SECRET")

#AB Permitir indicar um certificado de confiança para o HTTPS interno.
VIDEO_PROJECTS_CA_FILE = os.getenv("VIDEO_PROJECTS_CA_FILE")

#AB Identificador desta instância do worker.
WORKER_ID = os.getenv("VIDEO_WORKER_ID") or socket.gethostname()

#AB Intervalo entre comunicações de atividade do worker.
VIDEO_HEARTBEAT_INTERVAL = 15


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


#AB Reclamar uma execução no serviço projects antes de iniciar FFmpeg.
def reclamar_processamento(message_id):
    if not VIDEO_INTERNAL_SECRET:
        raise RuntimeError(
            "VIDEO_INTERNAL_SECRET não está configurado no worker."
        )

    corpo = json.dumps({
        "messageId": message_id,
        "workerId": WORKER_ID
    }).encode("utf-8")

    pedido = request.Request(
        VIDEO_CLAIM_URL,
        data=corpo,
        headers={
            "Content-Type": "application/json",
            "X-Video-Internal-Secret": VIDEO_INTERNAL_SECRET
        },
        method="POST"
    )

    contexto_ssl = ssl.create_default_context(
        cafile=VIDEO_PROJECTS_CA_FILE
    )

    try:
        with request.urlopen(
            pedido,
            timeout=15,
            context=contexto_ssl
        ) as resposta:
            dados = json.loads(resposta.read().decode("utf-8"))

    except error.HTTPError as erro:
        # Erros HTTP não autorizam a execução do FFmpeg.
        raise RuntimeError(
            f"Reclamação recusada pelo projects: HTTP {erro.code}"
        ) from erro

    if not isinstance(dados, dict):
        raise RuntimeError("Resposta inválida do serviço projects.")

    if dados.get("messageId") != message_id:
        raise RuntimeError(
            "O identificador da reclamação não corresponde ao pedido."
        )

    if dados.get("claimed") is True:
        if dados.get("workerId") != WORKER_ID:
            raise RuntimeError(
                "A reclamação foi atribuída a outro worker."
            )

        tentativa = dados.get("attempt")
        if type(tentativa) is not int or tentativa < 1:
            raise RuntimeError("A reclamação não devolveu uma tentativa válida.")
        return tentativa

    if dados.get("claimed") is False:
        return False

    raise RuntimeError(
        "O serviço projects não devolveu um resultado de reclamação válido."
    )


#AB Informar o serviço projects de que esta execução continua ativa.
def enviar_heartbeat(message_id):
    if not VIDEO_INTERNAL_SECRET:
        raise RuntimeError(
            "VIDEO_INTERNAL_SECRET não está configurado."
        )

    corpo = json.dumps({
        "messageId": message_id,
        "workerId": WORKER_ID
    }).encode("utf-8")

    #AB Utilizar o mesmo serviço interno da reclamação.
    heartbeat_url = VIDEO_CLAIM_URL.rsplit("/", 1)[0] + "/heartbeat"

    pedido = request.Request(
        heartbeat_url,
        data=corpo,
        headers={
            "Content-Type": "application/json",
            "X-Video-Internal-Secret": VIDEO_INTERNAL_SECRET
        },
        method="POST"
    )

    contexto_ssl = ssl.create_default_context(
        cafile=VIDEO_PROJECTS_CA_FILE
    )

    try:
        with request.urlopen(
            pedido,
            timeout=10,
            context=contexto_ssl
        ) as resposta:
            dados = json.loads(
                resposta.read().decode("utf-8")
            )

    except error.HTTPError as erro:
        if erro.code == 409:
            #AB O processo pode ter sido cancelado ou concluído.
            return False

        raise RuntimeError(
            f"Heartbeat recusado: HTTP {erro.code}"
        ) from erro

    if (
        not isinstance(dados, dict)
        or dados.get("messageId") != message_id
        or dados.get("workerId") != WORKER_ID
        or dados.get("active") is not True
    ):
        raise RuntimeError(
            "Resposta de heartbeat inválida."
        )

    return True


#AB Enviar heartbeats enquanto o FFmpeg estiver em execução.
def manter_heartbeat(message_id, parar):
    while not parar.wait(VIDEO_HEARTBEAT_INTERVAL):
        try:
            ativo = enviar_heartbeat(message_id)

            if not ativo:
                print(
                    f"[video_filters] Heartbeat recusado: {message_id}",
                    flush=True
                )

                #AB Não insistir num processo que já não está ativo.
                return

        except Exception as erro:
            #AB Uma falha temporária de comunicação não deve
            # terminar a thread nem interromper o FFmpeg.
            print(
                f"[video_filters] Falha no heartbeat "
                f"{message_id}: {erro}",
                flush=True
            )


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
        ligacao = None
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

            #AB Fila exclusiva para resultados de processamento de vídeo.
            canal.queue_declare(
                queue=RESULT_ROUTING_KEY,
                durable=True
            )

            #AB Associar a fila ao exchange utilizado pelo PictuRAS.
            canal.queue_bind(
                queue=RESULT_ROUTING_KEY,
                exchange=RESULT_EXCHANGE,
                routing_key=RESULT_ROUTING_KEY
            )

            #AB Exigir confirmação do RabbitMQ ao publicar resultados.
            canal.confirm_delivery()
            canal.basic_qos(prefetch_count=1)

            def callback(ch, method, properties, body):
                try:
                    mensagem = json.loads(body)
                    message_id = mensagem["messageId"]

                    if not isinstance(message_id, str):
                        raise ValueError("messageId inválido.")

                except (ValueError, KeyError, TypeError) as erro:
                    print(
                        f"[video_filters] Mensagem inválida: {erro}",
                        flush=True
                    )

                    #AB Uma mensagem sem identificador não pode ser
                    # reclamada nem associada a um VideoProcess.
                    ch.basic_reject(
                        delivery_tag=method.delivery_tag,
                        requeue=False
                    )
                    return

                try:
                    autorizado = reclamar_processamento(message_id)

                except Exception as erro:
                    print(
                        f"[video_filters] Não foi possível reclamar "
                        f"{message_id}: {erro}",
                        flush=True
                    )

                    #AB Sem confirmação do projects, não executar FFmpeg.
                    # A mensagem regressa à fila para futura entrega.
                    time.sleep(2)

                    ch.basic_nack(
                        delivery_tag=method.delivery_tag,
                        requeue=True
                    )
                    return

                if not autorizado:
                    print(
                        f"[video_filters] Execução duplicada ou "
                        f"já terminada: {message_id}",
                        flush=True
                    )

                    #AB Não executar FFmpeg nem publicar outro resultado.
                    ch.basic_ack(
                        delivery_tag=method.delivery_tag
                    )
                    return

                #AB Só o worker que reclamou a tarefa executa FFmpeg.
                parar_heartbeat = threading.Event()

                thread_heartbeat = threading.Thread(
                    target=manter_heartbeat,
                    args=(message_id, parar_heartbeat),
                    daemon=True
                )

                thread_heartbeat.start()

                try:
                    resposta = processar_pedido(mensagem)

                finally:
                    #AB Parar a comunicação periódica quando o FFmpeg terminar.
                    parar_heartbeat.set()

                    #AB Esperar que uma comunicação já iniciada termine.
                    thread_heartbeat.join(timeout=12)


                #AB Identificar a execução que produziu o resultado.
                #AB O consumidor rejeita respostas de tentativas antigas.
                resposta["metadata"]["workerId"] = WORKER_ID
                resposta["metadata"]["attempt"] = int(autorizado)

                #AB Publicar o resultado com confirmação do RabbitMQ.
                #AB mandatory=True exige que exista uma fila de destino.
                #AB confirm_delivery() faz com que falhas de publicação
                #AB sejam sinalizadas por exceção; não testar retorno True.
                ch.basic_publish(
                    exchange=RESULT_EXCHANGE,
                    routing_key=RESULT_ROUTING_KEY,
                    body=json.dumps(resposta),
                    properties=pika.BasicProperties(
                        delivery_mode=2,
                        content_type="application/json"
                    ),
                    mandatory=True
                )

                #AB Confirmar uma única vez o pedido original, apenas
                #AB depois de o RabbitMQ confirmar a publicação.
                ch.basic_ack(
                    delivery_tag=method.delivery_tag
                )

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

        except Exception as erro:
            #AB Não confirmar mensagens quando ocorre uma falha
            # de publicação ou de comunicação com o RabbitMQ.
            print(
                f"[video_filters] Falha no worker ou no RabbitMQ: {erro}",
                flush=True
            )

            #AB Fechar a ligação para que mensagens ainda não
            # confirmadas possam ser novamente entregues.
            try:
                if ligacao is not None and ligacao.is_open:
                    ligacao.close()
            except Exception as erro_fecho:
                print(
                    f"[video_filters] Erro ao fechar ligação: {erro_fecho}",
                    flush=True
                )

            time.sleep(5)


if __name__ == "__main__":
    executar_worker()