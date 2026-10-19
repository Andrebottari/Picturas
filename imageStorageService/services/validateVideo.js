const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);


//AB Inspecionar o conteúdo real de um ficheiro de vídeo.
async function validarVideo(caminhoFicheiro) {
  let resultado;

  try {
    const { stdout } = await execFileAsync(
      "ffprobe",
      [
        "-v", "error",
        "-show_entries",
        "format=format_name,duration:stream=codec_type,codec_name,width,height",
        "-of", "json",
        caminhoFicheiro
      ],
      {
        timeout: 30000,
        maxBuffer: 1024 * 1024
      }
    );

    resultado = JSON.parse(stdout);

  } catch (erro) {
    throw new Error(
      "Não foi possível analisar o ficheiro de vídeo."
    );
  }

  //AB Confirmar que o formato reconhecido é compatível com MP4.
  const formatos = (resultado.format?.format_name || "")
    .split(",");

  if (!formatos.includes("mp4")) {
    throw new Error("O ficheiro não foi reconhecido como MP4.");
  }

  //AB Encontrar a faixa principal de vídeo.
  const video = resultado.streams?.find(
    (stream) => stream.codec_type === "video"
  );

  if (!video) {
    throw new Error("O ficheiro não contém uma faixa de vídeo.");
  }

  if (video.codec_name !== "h264") {
    throw new Error(
      "O vídeo deve utilizar o codec H.264."
    );
  }

  const largura = Number(video.width);
  const altura = Number(video.height);
  const duracao = Number(resultado.format?.duration);

  //AB Rejeitar metadados inválidos ou incompletos.
  if (
    !Number.isFinite(largura) ||
    !Number.isFinite(altura) ||
    !Number.isFinite(duracao) ||
    largura <= 0 ||
    altura <= 0 ||
    duracao <= 0
  ) {
    throw new Error(
      "O vídeo apresenta dimensões ou duração inválidas."
    );
  }

  return {
    mime_type: "video/mp4",
    codec: "h264",
    duration_seconds: duracao,
    width: largura,
    height: altura
  };
}

module.exports = validarVideo;