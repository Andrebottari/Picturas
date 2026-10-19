import argparse
import math
import os
import subprocess
import tempfile
from pathlib import Path


# Nome: (filtro FFmpeg, valor predefinido, mínimo, máximo)
FILTROS = {
    "cinzento": ("hue=s=0", None, None, None),
    "brilho": ("eq=brightness={valor}", 0.15, -1.0, 1.0),
    "contraste": ("eq=contrast={valor}", 1.3, 0.0, 2.0),
    "saturacao": ("eq=saturation={valor}", 1.5, 0.0, 3.0),
}


def preparar_filtro(especificacao: str) -> str:
    """
    Converte uma especificação como 'brilho:0.2'
    numa expressão de filtro aceite pelo FFmpeg.
    """

    partes = especificacao.split(":", maxsplit=1)
    nome = partes[0].strip().lower()

    if nome not in FILTROS:
        raise ValueError(f"Filtro não suportado: {nome}")

    expressao, valor_predefinido, minimo, maximo = FILTROS[nome]

    # O filtro de tons de cinza não recebe parâmetros.
    if valor_predefinido is None:
        if len(partes) > 1:
            raise ValueError(
                f"O filtro '{nome}' não aceita parâmetros."
            )
        return expressao

    if len(partes) == 1:
        valor = valor_predefinido
    else:
        try:
            valor = float(partes[1])
        except ValueError as erro:
            raise ValueError(
                f"Parâmetro inválido para '{nome}'."
            ) from erro

    if not math.isfinite(valor):
        raise ValueError("O parâmetro deve ser um número finito.")

    if not minimo <= valor <= maximo:
        raise ValueError(
            f"O parâmetro de '{nome}' deve estar "
            f"entre {minimo} e {maximo}."
        )

    return expressao.format(valor=valor)


def aplicar_filtros(
    entrada: str,
    saida: str,
    filtros: list[str],
) -> None:
    """
    Aplica vários filtros visuais, pela ordem indicada,
    produzindo um novo vídeo MP4/H.264.
    """

    caminho_entrada = Path(entrada).resolve()
    caminho_saida = Path(saida).resolve()

    if not caminho_entrada.is_file():
        raise FileNotFoundError(
            f"O vídeo de entrada não existe: {caminho_entrada}"
        )

    if caminho_entrada.suffix.lower() != ".mp4":
        raise ValueError("O ficheiro de entrada deve ser MP4.")

    if caminho_saida.suffix.lower() != ".mp4":
        raise ValueError("O ficheiro de saída deve ser MP4.")

    if caminho_entrada == caminho_saida:
        raise ValueError(
            "O vídeo original não pode ser substituído."
        )

    if caminho_saida.exists():
        raise FileExistsError(
            f"O ficheiro de saída já existe: {caminho_saida}"
        )

    if not filtros:
        raise ValueError("É necessário indicar pelo menos um filtro.")

    expressoes = [preparar_filtro(filtro) for filtro in filtros]

    # A ordem da lista corresponde à ordem de aplicação.
    cadeia_filtros = ",".join(expressoes)

    caminho_saida.parent.mkdir(parents=True, exist_ok=True)

    # Criamos o resultado numa localização temporária.
    # Só o publicamos depois de o FFmpeg terminar com sucesso.
    with tempfile.NamedTemporaryFile(
        suffix=".mp4",
        prefix=".video_filters_",
        dir=caminho_saida.parent,
        delete=False,
    ) as temporario:
        caminho_temporario = Path(temporario.name)

    comando = [
        "ffmpeg",
        "-hide_banner",
        "-nostdin",
        "-y",
        "-i", str(caminho_entrada),
        "-map", "0:v:0",
        "-map", "0:a?",
        "-vf", cadeia_filtros,
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        "-c:a", "copy",
        str(caminho_temporario),
    ]

    try:
        subprocess.run(comando, check=True)

        if not caminho_temporario.is_file():
            raise RuntimeError("O FFmpeg não produziu o resultado.")

        # Publicação apenas após processamento bem-sucedido.
        os.replace(caminho_temporario, caminho_saida)

    finally:
        # Em caso de falha, eliminamos o ficheiro parcial.
        caminho_temporario.unlink(missing_ok=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Aplicar filtros visuais a vídeos."
    )

    parser.add_argument("entrada")
    parser.add_argument("saida")

    parser.add_argument(
        "--filtro",
        action="append",
        required=True,
        help=(
            "Filtro a aplicar. Pode repetir esta opção. "
            "Exemplos: cinzento, brilho:0.2, contraste:1.3."
        ),
    )

    argumentos = parser.parse_args()

    try:
        aplicar_filtros(
            argumentos.entrada,
            argumentos.saida,
            argumentos.filtro,
        )
    except (
        ValueError,
        FileNotFoundError,
        FileExistsError,
        subprocess.CalledProcessError,
    ) as erro:
        parser.exit(1, f"Erro: {erro}\n")