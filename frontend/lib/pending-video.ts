//AB Transferência temporária de um File entre a criação e a página do projeto.
// O vídeo permanece na memória do navegador; não é enviado sem confirmação.
let pendingVideo: File | null = null;

export function guardarVideoPendente(file: File) { pendingVideo = file; }
export function retirarVideoPendente(): File | null {
  const file = pendingVideo;
  pendingVideo = null;
  return file;
}
